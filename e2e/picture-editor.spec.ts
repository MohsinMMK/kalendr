import { randomUUID } from "node:crypto";

import { expect, test, type Locator, type Page, type Request } from "@playwright/test";
import { hashPassword } from "better-auth/crypto";

import { expectAccessible, signIn, unique, withOwnerDatabase } from "./support/journey";

const slug = "lotus-dental";
const owner = "kalendr.owner@example.com";
const savedLogo = randomUUID();
const savedCover = randomUUID();

/** A wide picture, red on the left and blue on the right, so a turn or a flip can be read back from the result. */
async function makeSource(page: Page): Promise<Buffer> {
  await page.setContent(`<body style="margin:0;width:1200px;height:800px;display:flex"><div style="flex:1;background:#dc2626"></div><div style="flex:1;background:#2563eb"></div></body>`);
  return page.screenshot({ type: "png", clip: { x: 0, y: 0, width: 1200, height: 800 } });
}

/** The width and height written in a JPEG's frame header. */
function jpegSize(bytes: Buffer): { width: number; height: number } {
  let offset = 2;
  while (offset < bytes.length) {
    const marker = bytes[offset + 1]!;
    const length = bytes.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  throw new Error("Not a JPEG.");
}

interface Upload {
  kind: string;
  jpeg: Buffer;
}

/** Stands in for the media route (the test server has no virus scanner and refuses real uploads) and records what was posted. */
async function interceptUploads(page: Page): Promise<Upload[]> {
  const uploads: Upload[] = [];
  await page.route("**/api/staff/media", async (route) => {
    const request: Request = route.request();
    if (request.method() !== "POST") return route.continue();
    const body = request.postDataBuffer();
    const boundary = /boundary=(.+)$/.exec(request.headers()["content-type"] ?? "")?.[1];
    if (!body || !boundary) return route.abort();
    const text = body.toString("latin1");
    const kind = /name="kind"\r\n\r\n([^\r]+)/.exec(text)?.[1] ?? "";
    const fileHeader = text.indexOf('name="file"');
    const start = text.indexOf("\r\n\r\n", fileHeader) + 4;
    const end = text.indexOf(`\r\n--${boundary}`, start);
    uploads.push({ kind, jpeg: body.subarray(start, end) });
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ data: { url: `/api/public/media/${slug}/${kind === "business_logo" ? savedLogo : kind === "business_cover" ? savedCover : randomUUID()}`, scanStatus: "skipped" } }) });
  });
  return uploads;
}

/** The colour of one pixel of a picture, read in the page. */
async function pixel(page: Page, jpeg: Buffer, x: number, y: number): Promise<[number, number, number]> {
  return page.evaluate(
    async ({ data, x, y }) => {
      const bytes = Uint8Array.from(atob(data), (letter) => letter.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      const [r, g, b] = context.getImageData(x, y, 1, 1).data;
      return [r!, g!, b!] as [number, number, number];
    },
    { data: jpeg.toString("base64"), x, y },
  );
}

const reddish = ([r, , b]: number[]) => r! > 150 && b! < 100;
const bluish = ([r, , b]: number[]) => b! > 150 && r! < 100;
const white = ([r, g, b]: number[]) => r! > 245 && g! > 245 && b! > 245;

function editorOf(page: Page, name: RegExp): Locator {
  return page.getByRole("dialog", { name });
}

async function choose(page: Page, trigger: Locator, item: RegExp, file: Buffer) {
  await trigger.click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: item }).click();
  (await chooser).setFiles({ name: "photo.png", mimeType: "image/png", buffer: file });
}

async function nudge(slider: Locator, key: string, times: number) {
  await slider.focus();
  for (let index = 0; index < times; index += 1) await slider.press(key);
}

/** Zooms in with the plus key, the way a keyboard user does, and checks the slider followed. */
async function zoomIn(editor: Locator, page: Page, presses = 3) {
  const zoom = editor.getByRole("slider", { name: "Zoom" });
  const before = Number(await zoom.inputValue());
  await editor.locator("[data-testid='cropper']").focus();
  for (let index = 0; index < presses; index += 1) await page.keyboard.press("+");
  await expect.poll(async () => Number(await zoom.inputValue())).toBeGreaterThan(before);
}

/** Drags with a finger, through the browser's own touch input, since Playwright has only taps. */
async function touchDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const session = await page.context().newCDPSession(page);
  const point = (x: number, y: number) => [{ x, y, id: 1 }];
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(from.x, from.y) });
  for (let step = 1; step <= 8; step += 1) {
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(from.x + ((to.x - from.x) * step) / 8, from.y + ((to.y - from.y) * step) / 8) });
  }
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await session.detach();
}

let source: Buffer;

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  source = await makeSource(page);
  await page.close();
  // The saved logo and cover, put in place directly: "Adjust" re-crops these.
  await withOwnerDatabase(async (sql) => {
    const [business] = await sql<{ id: string }[]>`select id from tenants where slug = ${slug}`;
    await sql`delete from media_assets where tenant_id = ${business!.id} and kind in ('business_cover', 'business_logo')`;
    for (const [id, kind] of [[savedLogo, "business_logo"], [savedCover, "business_cover"]] as const) {
      await sql`
        insert into media_assets (id, tenant_id, kind, owner_id, content_type, width, height, byte_size, data, scan_status)
        values (${id}, ${business!.id}, ${kind}, ${business!.id}, 'image/png', 1200, 800, ${source.byteLength}, ${source}, 'skipped')
      `;
    }
  });
});

test.afterAll(async () => {
  await withOwnerDatabase((sql) => sql`delete from media_assets where id in (${savedLogo}, ${savedCover})`);
});

test("the owner crops, turns and adjusts the logo and the cover, and Cancel uploads nothing", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "The editor's phone layout is checked in the personal photo journey.");
  const uploads = await interceptUploads(page);
  await signIn(page, owner, undefined, "/profile");
  const hero = page.locator("section[aria-labelledby='profile-name']");
  const logoButton = hero.getByRole("button", { name: /logo/ });
  const editor = editorOf(page, /Adjust logo/);

  // Cancel: the editor closes, nothing is sent, and focus is back on the logo's camera button.
  await choose(page, logoButton, /Upload a (new )?logo/, source);
  await expect(editor).toBeVisible();
  await expect(editor.getByRole("slider", { name: "Zoom" })).toBeVisible();
  await expectAccessible(page, testInfo, "picture editor, crop tab", "[data-picture-editor]");
  await editor.getByRole("tab", { name: "Adjust" }).click();
  await expect(editor.getByRole("slider", { name: "Brightness" })).toBeVisible();
  await expectAccessible(page, testInfo, "picture editor, adjust tab", "[data-picture-editor]");
  if (process.env.KALENDR_E2E_SHOTS) await page.screenshot({ path: `${process.env.KALENDR_E2E_SHOTS}/picture-editor-logo.png` });
  await editor.getByRole("button", { name: "Cancel" }).click();
  await expect(editor).toBeHidden();
  await expect(logoButton).toBeFocused();
  expect(uploads).toHaveLength(0);

  // A plain save is exactly 256 by 256: red on the left, blue on the right, and no empty corners.
  await choose(page, logoButton, /Upload a (new )?logo/, source);
  await expect(editor.getByRole("slider", { name: "Zoom" })).toBeVisible();
  await expect.poll(async () => editor.locator("[data-testid='cropper']").count()).toBe(1);
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor).toBeHidden();
  await expect.poll(() => uploads.length).toBe(1);
  expect(uploads[0]!.kind).toBe("business_logo");
  expect(jpegSize(uploads[0]!.jpeg)).toEqual({ width: 256, height: 256 });
  expect(reddish(await pixel(page, uploads[0]!.jpeg, 20, 128))).toBe(true);
  expect(bluish(await pixel(page, uploads[0]!.jpeg, 236, 128))).toBe(true);

  // Flip: left and right swap.
  await choose(page, logoButton, /Upload a (new )?logo/, source);
  await editor.getByRole("button", { name: "Flip" }).click();
  await editor.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => uploads.length).toBe(2);
  expect(bluish(await pixel(page, uploads[1]!.jpeg, 20, 128))).toBe(true);
  expect(reddish(await pixel(page, uploads[1]!.jpeg, 236, 128))).toBe(true);

  // Turned right: the left side is now on top. Zoomed with the keyboard, straightened and made brighter: still 256 square, corners filled.
  await choose(page, logoButton, /Upload a (new )?logo/, source);
  await editor.getByRole("button", { name: "Rotate right" }).click();
  await editor.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => uploads.length).toBe(3);
  expect(reddish(await pixel(page, uploads[2]!.jpeg, 128, 20))).toBe(true);
  expect(bluish(await pixel(page, uploads[2]!.jpeg, 128, 236))).toBe(true);

  await choose(page, logoButton, /Upload a (new )?logo/, source);
  await zoomIn(editor, page, 2);
  await page.keyboard.press("ArrowLeft");
  await nudge(editor.getByRole("slider", { name: "Straighten" }), "ArrowRight", 20);
  // Dragged as far as it goes into a corner: the frame still sits inside the tilted picture.
  await editor.locator("[data-testid='cropper']").focus();
  for (let index = 0; index < 60; index += 1) await page.keyboard.press("ArrowLeft");
  for (let index = 0; index < 60; index += 1) await page.keyboard.press("ArrowUp");
  await editor.getByRole("tab", { name: "Adjust" }).click();
  await nudge(editor.getByRole("slider", { name: "Brightness" }), "ArrowRight", 30);
  await editor.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => uploads.length).toBe(4);
  expect(jpegSize(uploads[3]!.jpeg)).toEqual({ width: 256, height: 256 });
  for (const [x, y] of [[2, 2], [253, 2], [2, 253], [253, 253]] as const) expect(white(await pixel(page, uploads[3]!.jpeg, x, y))).toBe(false);
  // Brighter than the plain red.
  expect((await pixel(page, uploads[3]!.jpeg, 20, 128))[0]).toBeGreaterThan(220);

  // The cover: a wide 1600 by 900 picture, from a new file and again from the saved cover with "Adjust cover".
  const coverEditor = editorOf(page, /Adjust cover photo/);
  const coverButton = hero.getByRole("button", { name: /cover/ });
  await choose(page, coverButton, /Upload a (new )?cover/, source);
  await expect(coverEditor).toBeVisible();
  await zoomIn(coverEditor, page);
  await coverEditor.getByRole("button", { name: "Rotate right" }).click();
  await coverEditor.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => uploads.length).toBe(5);
  expect(uploads[4]!.kind).toBe("business_cover");
  expect(jpegSize(uploads[4]!.jpeg)).toEqual({ width: 1600, height: 900 });

  await coverButton.click();
  await page.getByRole("menuitem", { name: "Adjust cover" }).click();
  await expect(coverEditor).toBeVisible();
  await expect.poll(async () => coverEditor.locator("[data-testid='cropper']").count()).toBe(1);
  if (process.env.KALENDR_E2E_SHOTS) await page.screenshot({ path: `${process.env.KALENDR_E2E_SHOTS}/picture-editor-cover.png` });
  await coverEditor.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => uploads.length).toBe(6);
  expect(uploads[5]!.kind).toBe("business_cover");
  expect(jpegSize(uploads[5]!.jpeg)).toEqual({ width: 1600, height: 900 });
  await expect(coverButton).toBeFocused();

  // "Adjust logo" on the saved logo re-crops it too.
  await logoButton.click();
  await page.getByRole("menuitem", { name: "Adjust logo" }).click();
  await expect(editor).toBeVisible();
  await editor.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => uploads.length).toBe(7);
  expect(jpegSize(uploads[6]!.jpeg)).toEqual({ width: 256, height: 256 });
});

test("a receptionist adds their own photo: round, 256 square, and the editor fills a phone", async ({ page }, testInfo) => {
  const email = `desk.${unique()}@example.com`;
  const password = `Pw-${randomUUID()}`;
  const id = randomUUID();
  await withOwnerDatabase(async (sql) => {
    const [business] = await sql<{ id: string }[]>`select id from tenants where slug = ${slug}`;
    await sql`insert into auth_users (id, name, email, email_verified, password_set_at) values (${id}, 'Pic Desk', ${email}, true, now())`;
    await sql`insert into auth_accounts (id, issuer, account_id, provider_id, user_id, password) values (${randomUUID()}, 'local:credential', ${id}, 'credential', ${id}, ${await hashPassword(password)})`;
    await sql`insert into memberships (tenant_id, user_id, role) values (${business!.id}, ${id}, 'receptionist')`;
  });
  try {
    const uploads = await interceptUploads(page);
    await page.setViewportSize({ width: 360, height: 740 });
    await page.context().setExtraHTTPHeaders({ "x-forwarded-for": `192.0.2.${testInfo.project.name === "phone" ? 176 : 76}` });
    await signIn(page, email, password, "/profile");
    const trigger = page.locator("#account").getByRole("button", { name: "Add photo" });
    await choose(page, trigger, /Upload a photo/, source);
    const editor = editorOf(page, /Adjust photo/);
    await expect(editor).toBeVisible();
    await expect.poll(async () => editor.locator("[data-testid='cropper']").count()).toBe(1);

    // Full screen on a phone: the editor covers the whole window.
    const box = await editor.boundingBox();
    expect(box).toBeTruthy();
    expect(Math.round(box!.x)).toBe(0);
    expect(Math.round(box!.y)).toBe(0);
    expect(Math.round(box!.width)).toBe(360);
    expect(Math.round(box!.height)).toBe(740);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(editor.getByRole("button", { name: "Save" })).toBeInViewport();
    if (process.env.KALENDR_E2E_SHOTS) await page.screenshot({ path: `${process.env.KALENDR_E2E_SHOTS}/picture-editor-phone.png` });

    // The round frame: the crop area has a fully rounded shape.
    const radius = await editor.locator("[data-testid='cropper']").evaluate((element) => getComputedStyle(element).borderTopLeftRadius);
    expect(radius).toBe("50%");

    // Escape closes just the editor.
    await page.keyboard.press("Escape");
    await expect(editor).toBeHidden();
    expect(uploads).toHaveLength(0);

    await choose(page, trigger, /Upload a photo/, source);
    await expect.poll(async () => editor.locator("[data-testid='cropper']").count()).toBe(1);
    await zoomIn(editor, page);
    await editor.getByRole("button", { name: "Rotate left" }).click();
    await editor.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => uploads.length).toBe(1);
    expect(uploads[0]!.kind).toBe("staff_photo");
    expect(jpegSize(uploads[0]!.jpeg)).toEqual({ width: 256, height: 256 });
  } finally {
    await withOwnerDatabase(async (sql) => {
      await sql`delete from memberships where user_id = ${id}`;
      await sql`delete from auth_sessions where user_id = ${id}`;
      await sql`delete from auth_accounts where user_id = ${id}`;
      await sql`delete from auth_users where id = ${id}`;
    });
  }
});

test("the editor opens over the practitioner drawer, stacks, and hands focus back", async ({ page }, testInfo) => {
  const phone = testInfo.project.name === "phone";
  await signIn(page, owner, undefined, "/doctors");
  await page.getByRole("button", { name: /^Add (a )?(doctor|practitioner|stylist|therapist|provider|team member)/i }).first().click();
  const drawer = page.getByRole("dialog").first();
  await expect(drawer).toBeVisible();
  const trigger = drawer.getByRole("button", { name: "Add photo" });
  await choose(page, trigger, /Upload a photo/, source);
  const editor = editorOf(page, /Adjust photo/);
  await expect(editor).toBeVisible();
  await expect.poll(async () => editor.locator("[data-testid='cropper']").count()).toBe(1);

  // Stacked above the drawer, which stays open behind it: dragging the picture, with the mouse or a finger and in
  // the direction that would slide the drawer away, does not dismiss it.
  const stage = await editor.locator("[data-slot='picture-editor-stage']").boundingBox();
  const middle = { x: stage!.x + stage!.width / 2, y: stage!.y + stage!.height / 2 };
  if (phone) {
    await touchDrag(page, middle, { x: middle.x + 140, y: middle.y });
    await touchDrag(page, middle, { x: middle.x, y: middle.y + 140 });
  } else {
    await page.mouse.move(middle.x, middle.y);
    await page.mouse.down();
    await page.mouse.move(middle.x + 120, middle.y, { steps: 6 });
    await page.mouse.up();
  }
  await expect(drawer).toBeVisible();
  await expect(editor).toBeVisible();
  await expectAccessible(page, testInfo, "picture editor over the drawer", "[data-picture-editor]");

  // Escape closes only the editor and gives focus back to the photo menu's button.
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  await expect(drawer).toBeVisible();
  await expect(trigger).toBeFocused();

  await choose(page, trigger, /Upload a photo/, source);
  await expect.poll(async () => editor.locator("[data-testid='cropper']").count()).toBe(1);
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor).toBeHidden();
  // The practitioner's photo is kept as a data address of a 256 square JPEG, and shows in the drawer.
  const avatar = drawer.locator("[data-slot='avatar-image']");
  await expect(avatar).toBeVisible();
  const photo = await avatar.getAttribute("src");
  expect(photo).toMatch(/^data:image\/jpeg;base64,/);
  const size = jpegSize(Buffer.from(photo!.split(",")[1]!, "base64"));
  expect(size).toEqual({ width: 256, height: 256 });
  await expect(drawer.getByRole("button", { name: "Change photo" })).toBeFocused();

  // "Adjust photo" re-crops the saved photo from inside the same menu.
  await drawer.getByRole("button", { name: "Change photo" }).click();
  await page.getByRole("menuitem", { name: "Adjust photo" }).click();
  await expect(editor).toBeVisible();
  await expect.poll(async () => editor.locator("[data-testid='cropper']").count()).toBe(1);
  await editor.getByRole("button", { name: "Cancel" }).click();
  await expect(editor).toBeHidden();
  await expect(drawer.getByRole("button", { name: "Change photo" })).toBeFocused();
  await expect(drawer).toBeVisible();
});

test("the picture control in Settings uses the same editor: a service picture comes out 960 by 720", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "The service editor's own layout is covered by its journeys.");
  const uploads = await interceptUploads(page);
  await signIn(page, owner);
  const name = `Picture journey ${unique()}`;
  const created = await page.request.post("/api/staff/services", { data: { name, description: "Made by the picture editor journey.", durationMinutes: 30 } });
  expect(created.status()).toBe(201);
  const serviceId = ((await created.json()) as { data: { serviceId: string } }).data.serviceId;
  await page.goto(`/services/${serviceId}`);
  const drawer = page.locator("main");
  await drawer.getByRole("tab", { name: "Look" }).click();
  const add = drawer.getByRole("button", { name: "Add picture" });
  const chooser = page.waitForEvent("filechooser");
  await add.click();
  (await chooser).setFiles({ name: "photo.png", mimeType: "image/png", buffer: source });
  const editor = editorOf(page, /Adjust service picture/);
  await expect(editor).toBeVisible();
  await expect.poll(async () => editor.locator("[data-testid='cropper']").count()).toBe(1);
  await zoomIn(editor, page);
  await editor.getByRole("button", { name: "Rotate left" }).click();
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor).toBeHidden();
  await expect.poll(() => uploads.length).toBe(1);
  expect(uploads[0]!.kind).toBe("service");
  expect(jpegSize(uploads[0]!.jpeg)).toEqual({ width: 960, height: 720 });
  // The picture control's own Adjust button: Cancel uploads nothing and gives focus back to it.
  const adjust = drawer.getByRole("button", { name: "Adjust" });
  await adjust.click();
  await expect(editor).toBeVisible();
  await editor.getByRole("button", { name: "Cancel" }).click();
  await expect(editor).toBeHidden();
  await expect(adjust).toBeFocused();
  expect(uploads).toHaveLength(1);
});
