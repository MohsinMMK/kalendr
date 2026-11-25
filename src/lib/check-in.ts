import { encode } from "uqr";

/** Where the booking's QR code points. Staff of the business get the check-in screen; anyone else gets the manage page. */
export function checkInPath(manageToken: string): string {
  return `/check-in/${encodeURIComponent(manageToken)}`;
}

/** A short code the customer can read out if the QR can't be scanned, such as "3F9A-C21B". */
export function bookingReference(appointmentId: string): string {
  const letters = appointmentId.replace(/[^a-z0-9]/gi, "").slice(0, 8).toUpperCase();
  return letters.length > 4 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : letters;
}

/**
 * The QR code as one SVG path, one square per dark module, with a quiet border.
 * Medium error correction keeps the code small but still readable on a cracked screen.
 */
export function qrCodePath(text: string): { size: number; path: string } {
  const { data, size } = encode(text, { ecc: "M", border: 2 });
  let path = "";
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      if (data[row]?.[column]) path += `M${column} ${row}h1v1h-1z`;
    }
  }
  return { size, path };
}
