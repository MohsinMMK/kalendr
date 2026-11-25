import type { ImportKind } from "./contracts";
import { customerImporter } from "./customers";
import type { KindImporter } from "./kinds";
import { serviceImporter } from "./services-import";

/** The appointment importer pulls in the whole booking code, so it is loaded only when an appointment import runs. */
export async function importerFor(kind: ImportKind): Promise<KindImporter> {
  if (kind === "customers") return customerImporter;
  if (kind === "services") return serviceImporter;
  return (await import("./appointments-import")).appointmentImporter;
}
