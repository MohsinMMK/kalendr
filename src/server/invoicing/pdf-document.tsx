import { Document, Font, Page, renderToBuffer, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { ComponentProps } from "react";

type Style = ComponentProps<typeof View>["style"];

import { documentTitles, gstStateName, stateTaxLabel, type DocumentKind } from "../../lib/gst";
import { formatPdfMoney } from "./format";
import { latin400Font, latin700Font, rupeeFont } from "./fonts/noto";

/**
 * The invoice and credit note PDFs (feature 24). Rendered in the worker, never in a request. Plain data in, bytes out,
 * so it can be tested without a database. The layout follows the GST rules: seller and buyer, place of supply,
 * HSN/SAC, taxable value, each tax and the total, and the exemption wording when nothing is charged.
 */

Font.register({ family: "Noto", fonts: [{ src: latin400Font, fontWeight: 400 }, { src: latin700Font, fontWeight: 700 }] });
// The Latin file has no rupee sign; it lives in the Devanagari file, so the sign alone is set in that one.
Font.register({ family: "NotoRupee", src: rupeeFont });
Font.registerHyphenationCallback((word) => [word]);

export interface PdfLine {
  position: number;
  description: string;
  sacCode: string | null;
  quantity: number;
  unitPriceMinor: number;
  discountMinor: number;
  rateBps: number;
  taxableMinor: number;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  totalMinor: number;
}

export interface PdfDocumentInput {
  documentKind: DocumentKind | "credit_note";
  number: string;
  issuedOn: string;
  currency: string;
  seller: { legalName: string; address: string | null; gstin: string | null; stateCode: string | null };
  buyer: { name: string; gstin: string | null; stateCode: string | null };
  placeOfSupplyState: string | null;
  supply: "intra" | "inter" | "none";
  lines: PdfLine[];
  totals: { taxableMinor: number; cgstMinor: number; sgstMinor: number; igstMinor: number; totalMinor: number };
  exemptionNote: string | null;
  /** Credit notes: the invoice this corrects, and why. */
  againstNumber?: string;
  reason?: string;
}

const colors = { ink: "#1b1b1f", muted: "#63636b", line: "#d9d9de", band: "#f3f3f5" };

const styles = StyleSheet.create({
  page: { fontFamily: "Noto", fontSize: 9, color: colors.ink, paddingTop: 40, paddingBottom: 48, paddingHorizontal: 40, lineHeight: 1.4 },
  head: { flexDirection: "row", justifyContent: "space-between", marginBottom: 18 },
  title: { fontSize: 18, fontWeight: 700 },
  small: { color: colors.muted, fontSize: 8 },
  sub: { color: colors.muted, fontSize: 8, marginTop: 4 },
  bold: { fontWeight: 700 },
  parties: { flexDirection: "row", gap: 16, marginBottom: 16 },
  party: { flex: 1, padding: 8, backgroundColor: colors.band, borderRadius: 3 },
  partyLabel: { color: colors.muted, fontSize: 7.5, marginBottom: 3, textTransform: "uppercase" },
  row: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: colors.line, paddingVertical: 4 },
  headRow: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: colors.ink, paddingBottom: 4 },
  cell: { paddingRight: 4 },
  right: { textAlign: "right" },
  totals: { marginTop: 10, alignSelf: "flex-end", width: 230 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 },
  grand: { flexDirection: "row", justifyContent: "space-between", borderTopWidth: 1, borderTopColor: colors.ink, marginTop: 4, paddingTop: 4, fontSize: 11, fontWeight: 700 },
  note: { marginTop: 14, color: colors.muted, fontSize: 8 },
  footer: { position: "absolute", bottom: 24, left: 40, right: 40, color: colors.muted, fontSize: 7.5, textAlign: "center" },
});

function Money({ minor, currency, style }: { minor: number; currency: string; style?: Style }) {
  const text = formatPdfMoney(minor, currency);
  const sign = text.indexOf("₹");
  if (sign < 0) return <Text style={style}>{text}</Text>;
  return (
    <Text style={style}>
      {text.slice(0, sign)}
      <Text style={{ fontFamily: "NotoRupee" }}>₹</Text>
      {text.slice(sign + 1)}
    </Text>
  );
}

const widths = { no: "5%", desc: "27%", sac: "9%", qty: "6%", rate: "9%", taxable: "14%", tax: "16%", total: "14%" } as const;

function PartyBlock({ label, name, address, gstin, stateCode }: { label: string; name: string; address?: string | null; gstin: string | null; stateCode: string | null }) {
  const state = gstStateName(stateCode);
  return (
    <View style={styles.party}>
      <Text style={styles.partyLabel}>{label}</Text>
      <Text style={styles.bold}>{name}</Text>
      {address ? <Text>{address}</Text> : null}
      {gstin ? <Text>GSTIN: {gstin}</Text> : null}
      {state ? <Text>State: {state} ({stateCode})</Text> : null}
    </View>
  );
}

export function InvoicePdf({ input }: { input: PdfDocumentInput }) {
  const credit = input.documentKind === "credit_note";
  const title = credit ? "Credit note" : documentTitles[input.documentKind as DocumentKind];
  const sign = credit ? -1 : 1;
  const money = (minor: number) => sign * minor;
  const taxed = input.supply !== "none";
  const stateLabel = stateTaxLabel(input.placeOfSupplyState ?? input.seller.stateCode);
  return (
    <Document title={`${title} ${input.number}`} author={input.seller.legalName} creator="Kalendr" producer="Kalendr">
      <Page size="A4" style={styles.page}>
        <View style={styles.head}>
          <View>
            <Text style={styles.title}>{title}</Text>
            <Text style={styles.sub}>{input.seller.legalName}</Text>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={styles.bold}>No. {input.number}</Text>
            <Text>Date: {input.issuedOn}</Text>
            {input.againstNumber ? <Text>Against invoice {input.againstNumber}</Text> : null}
          </View>
        </View>
        <View style={styles.parties}>
          <PartyBlock label="From" name={input.seller.legalName} address={input.seller.address} gstin={input.seller.gstin} stateCode={input.seller.stateCode} />
          <PartyBlock label={credit ? "Credited to" : "Billed to"} name={input.buyer.name} gstin={input.buyer.gstin} stateCode={input.buyer.stateCode} />
        </View>
        {input.seller.gstin && input.placeOfSupplyState ? <Text style={{ marginBottom: 8 }}>Place of supply: {gstStateName(input.placeOfSupplyState)} ({input.placeOfSupplyState})</Text> : null}
        {credit && input.reason ? <Text style={{ marginBottom: 8 }}>Reason: {input.reason}</Text> : null}

        <View style={styles.headRow} fixed>
          <Text style={[styles.cell, styles.bold, { width: widths.no }]}>#</Text>
          <Text style={[styles.cell, styles.bold, { width: widths.desc }]}>Description</Text>
          <Text style={[styles.cell, styles.bold, { width: widths.sac }]}>HSN/SAC</Text>
          <Text style={[styles.cell, styles.bold, styles.right, { width: widths.qty }]}>Qty</Text>
          <Text style={[styles.cell, styles.bold, styles.right, { width: widths.rate }]}>Rate</Text>
          <Text style={[styles.cell, styles.bold, styles.right, { width: widths.taxable }]}>{taxed ? "Taxable" : "Amount"}</Text>
          <Text style={[styles.cell, styles.bold, styles.right, { width: widths.tax }]}>{taxed ? (input.supply === "intra" ? `CGST+${stateLabel}` : "IGST") : "Tax"}</Text>
          <Text style={[styles.bold, styles.right, { width: widths.total }]}>Total</Text>
        </View>
        {input.lines.map((line) => (
          <View key={line.position} style={styles.row} wrap={false}>
            <Text style={[styles.cell, { width: widths.no }]}>{line.position}</Text>
            <View style={[styles.cell, { width: widths.desc }]}>
              <Text>{line.description}</Text>
              {line.discountMinor > 0 ? <Text style={styles.small}>after discount of {formatPdfMoney(line.discountMinor, input.currency)}</Text> : null}
            </View>
            <Text style={[styles.cell, { width: widths.sac }]}>{line.sacCode ?? ""}</Text>
            <Text style={[styles.cell, styles.right, { width: widths.qty }]}>{line.quantity}</Text>
            <Text style={[styles.cell, styles.right, { width: widths.rate }]}>{line.rateBps > 0 ? `${(line.rateBps / 100).toFixed(line.rateBps % 100 === 0 ? 0 : 2)}%` : taxed ? "0%" : "-"}</Text>
            <Money minor={money(line.taxableMinor)} currency={input.currency} style={[styles.cell, styles.right, { width: widths.taxable }]} />
            <Money minor={money(line.cgstMinor + line.sgstMinor + line.igstMinor)} currency={input.currency} style={[styles.cell, styles.right, { width: widths.tax }]} />
            <Money minor={money(line.totalMinor)} currency={input.currency} style={[styles.right, { width: widths.total }]} />
          </View>
        ))}

        <View style={styles.totals} wrap={false}>
          <View style={styles.totalRow}><Text>{taxed ? "Taxable value" : "Amount"}</Text><Money minor={money(input.totals.taxableMinor)} currency={input.currency} /></View>
          {input.supply === "intra" ? (
            <>
              <View style={styles.totalRow}><Text>CGST</Text><Money minor={money(input.totals.cgstMinor)} currency={input.currency} /></View>
              <View style={styles.totalRow}><Text>{stateLabel}</Text><Money minor={money(input.totals.sgstMinor)} currency={input.currency} /></View>
            </>
          ) : null}
          {input.supply === "inter" ? <View style={styles.totalRow}><Text>IGST</Text><Money minor={money(input.totals.igstMinor)} currency={input.currency} /></View> : null}
          <View style={styles.grand}><Text>{credit ? "Total credited" : "Total"}</Text><Money minor={money(input.totals.totalMinor)} currency={input.currency} /></View>
        </View>

        {input.exemptionNote ? <Text style={styles.note}>{input.exemptionNote}</Text> : null}
        {input.documentKind === "receipt" ? <Text style={styles.note}>The seller is not registered for GST. No tax is charged on this receipt.</Text> : null}
        <Text style={styles.footer} fixed render={({ pageNumber, totalPages }) => `${input.seller.legalName} · ${title} ${input.number} · page ${pageNumber} of ${totalPages}`} />
      </Page>
    </Document>
  );
}

/** The PDF bytes. Loaded lazily by `pdf.ts` so the worker starts without pulling in the PDF engine. */
export async function renderInvoicePdfNow(input: PdfDocumentInput): Promise<Buffer> {
  return renderToBuffer(<InvoicePdf input={input} />);
}
