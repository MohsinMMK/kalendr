import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ImageUpload } from "@/components/image-upload";

describe("picture control in preview", () => {
  it("starts from the sample picture, and Remove clears it for this visit only", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ImageUpload kind="business_logo" label="Logo" url="/demo/dental/logo.svg" saves={false} />,
    );

    expect(screen.getByRole("img", { name: "Logo now in use" })).toHaveAttribute("src", "/demo/dental/logo.svg");
    expect(screen.getByRole("button", { name: "Replace" })).toBeInTheDocument();
    expect(screen.getByText(/Preview doesn.t save pictures/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.queryByRole("img", { name: "Logo now in use" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add picture" })).toBeInTheDocument();

    // A new sample (another business type) replaces the local change.
    rerender(<ImageUpload kind="business_logo" label="Logo" url={null} saves={false} />);
    expect(screen.queryByRole("img", { name: "Logo now in use" })).not.toBeInTheDocument();
    rerender(<ImageUpload kind="business_logo" label="Logo" url="/demo/dental/logo.svg" saves={false} />);
    expect(screen.getByRole("img", { name: "Logo now in use" })).toHaveAttribute("src", "/demo/dental/logo.svg");
  });
});
