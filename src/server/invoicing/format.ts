/** "₹1,234.50", with the sign in the font that has it. Always two decimals on an invoice. */
export function formatPdfMoney(minor: number, currency: string): string {
  const negative = minor < 0;
  const absolute = Math.abs(minor);
  const grouped = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(absolute / 100);
  return `${negative ? "-" : ""}${currency === "INR" ? "₹" : `${currency} `}${grouped}`;
}
