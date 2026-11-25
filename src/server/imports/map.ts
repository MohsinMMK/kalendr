import type { ImportFieldView, ImportKind, ImportMapping } from "./contracts";

/**
 * What each kind of import can fill in, and how a spreadsheet's own column names are matched to those fields. A guess is
 * only a starting point: the owner sees it and corrects it before anything is checked.
 */

interface FieldDefinition extends ImportFieldView {
  /** Header names (letters and digits only, lower case) that mean this field exactly. */
  names: readonly string[];
  /** A header containing one of these (and nothing in `avoid`) is a weaker match, tried after every exact match. */
  contains?: readonly string[];
  avoid?: readonly string[];
}

const phoneNames = ["phone", "phoneno", "phonenumber", "phonenum", "mobile", "mobileno", "mobilenumber", "mob", "contact", "contactno", "contactnumber", "cell", "cellphone", "cellno", "tel", "telephone", "telno", "whatsapp", "whatsappno", "whatsappnumber", "primaryphone", "mobilephone"];
const emailNames = ["email", "emailaddress", "emailid", "mail", "mailid", "emailaddr", "eaddress"];

export const importFields: Record<ImportKind, readonly FieldDefinition[]> = {
  customers: [
    { key: "firstName", label: "First name", required: true, description: "Given name. If first and last name share one column, map that column to Full name instead.", names: ["firstname", "first", "givenname", "forename", "fname", "firstnames"], contains: ["first", "given"] },
    { key: "lastName", label: "Last name", required: false, description: "Family name. Can be left empty.", names: ["lastname", "last", "surname", "familyname", "lname", "secondname"], contains: ["surname", "lastname"] },
    { key: "fullName", label: "Full name", required: false, description: "Use when first and last name are in one column. It is split at the last space.", names: ["name", "fullname", "customername", "clientname", "patientname", "contactname", "customer", "client", "patient", "guestname"] },
    { key: "phone", label: "Phone", required: true, description: "Mobile number. Numbers without a country code use the business's country.", names: phoneNames, contains: ["phone", "mobile", "whatsapp", "cell"], avoid: ["name", "email"] },
    { key: "email", label: "Email", required: false, description: "Email address. Used to spot duplicates.", names: emailNames, contains: ["email"] },
    { key: "dateOfBirth", label: "Date of birth", required: false, description: "Read in the date format you choose. Dates in the future are refused.", names: ["dob", "dateofbirth", "birthdate", "birthday", "born", "birth", "dateofbirthddmmyyyy"], contains: ["birth"] },
    { key: "preferredChannel", label: "Preferred channel", required: false, description: "text, whatsapp, email or phone. Left empty, it is email when there is an email address, otherwise phone.", names: ["preferredchannel", "preferredcontact", "contactmethod", "preferredcontactmethod", "channel", "preferredmethod"], contains: ["channel", "preferredcontact"] },
    { key: "messagingConsent", label: "Agreed to text messages", required: false, description: "yes or no. You must confirm you hold this consent before the import starts.", names: ["messagingconsent", "consent", "optin", "optedin", "smsconsent", "whatsappconsent", "textconsent", "messageconsent", "consenttomessages"], contains: ["consent", "optin"] },
    { key: "accessibilityNeed", label: "Accessibility need", required: false, description: "Any access need to remember, such as step-free access.", names: ["accessibilityneed", "accessibilityneeds", "accessibility", "accessneeds", "specialneeds", "accessibilitynotes", "disability"], contains: ["accessib"] },
  ],
  services: [
    { key: "name", label: "Service name", required: true, description: "What the service is called. At least 2 characters.", names: ["name", "servicename", "service", "title", "treatment", "treatmentname", "procedure", "item", "servicetitle"], contains: ["service"] },
    { key: "durationMinutes", label: "Length in minutes", required: true, description: "A number of minutes, or text like 1h 30m. Between 5 minutes and 8 hours.", names: ["duration", "durationminutes", "durationmins", "minutes", "mins", "length", "lengthminutes", "timemins", "time"], contains: ["duration", "minutes", "mins"] },
    { key: "price", label: "Price", required: false, description: "An exact price such as 800 or Rs 1,200. Text such as From 500 is kept as a label.", names: ["price", "cost", "fee", "charge", "amount", "rate", "mrp", "pricerupees", "pricelabel"], contains: ["price", "cost", "fee"] },
    { key: "description", label: "Description", required: false, description: "Shown on the booking page. Left empty, the service name is used.", names: ["description", "details", "about", "summary", "notes"], contains: ["descr"] },
    { key: "category", label: "Category", required: false, description: "Groups services on the booking page.", names: ["category", "group", "type", "department", "section", "servicecategory"], contains: ["categor"] },
    { key: "mode", label: "Booking mode", required: false, description: "instant (booked straight away) or request (you approve first). Left empty, instant.", names: ["mode", "bookingmode", "booking", "bookingtype", "approval"], contains: ["bookingmode"] },
  ],
  appointments: [
    { key: "customerPhone", label: "Customer phone", required: false, description: "Matches a customer you already have. Either phone or email is needed.", names: phoneNames, contains: ["phone", "mobile", "whatsapp", "cell"], avoid: ["name", "email", "staff"] },
    { key: "customerEmail", label: "Customer email", required: false, description: "Matches a customer you already have. Either phone or email is needed.", names: emailNames, contains: ["email"] },
    { key: "service", label: "Service", required: true, description: "The name of an existing service.", names: ["service", "servicename", "treatment", "treatmentname", "procedure", "servicetype", "appointmenttype"], contains: ["service", "treatment"] },
    { key: "staff", label: "Staff member", required: true, description: "The name of an existing staff member.", names: ["staff", "staffmember", "staffname", "practitioner", "doctor", "dr", "provider", "stylist", "therapist", "with", "employee", "assignedto", "consultant", "teammember", "professional"], contains: ["staff", "doctor", "practitioner", "stylist", "therapist", "provider"] },
    { key: "startsAt", label: "Date, or date and time", required: true, description: "A date such as 12/03/2027, or date and time in one column. If time is in its own column, map that below.", names: ["startsat", "start", "startdate", "startdatetime", "datetime", "appointmentdate", "appointmentdatetime", "date", "day", "when", "scheduledat", "bookingdate"], contains: ["date"], avoid: ["birth", "dob", "created"] },
    { key: "startTime", label: "Time", required: false, description: "Only when the time is in a column of its own.", names: ["time", "starttime", "appointmenttime", "slot", "timeslot", "bookingtime"], contains: ["time"], avoid: ["date", "duration", "length"] },
    { key: "durationMinutes", label: "Length in minutes", required: false, description: "Left empty, the service's usual length is used.", names: ["duration", "durationminutes", "durationmins", "minutes", "mins", "length"], contains: ["duration", "minutes"] },
  ],
};

export function fieldViews(kind: ImportKind): ImportFieldView[] {
  return importFields[kind].map(({ key, label, required, description }) => ({ key, label, required, description }));
}

/** Header text reduced to lower-case letters and digits, so "Phone No.", "phone_no" and "PHONE NO" are the same. */
export function headerKey(header: string): string {
  return header.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Which column feeds which field, guessed from the header names. Each column is used for at most one field. */
export function guessMapping(headers: readonly string[], kind: ImportKind): ImportMapping {
  const keys = headers.map(headerKey);
  const mapping: ImportMapping = {};
  const used = new Set<number>();
  const fields = importFields[kind];
  for (const field of fields) mapping[field.key] = null;
  const claim = (fieldKey: string, index: number) => {
    mapping[fieldKey] = index;
    used.add(index);
  };
  for (const field of fields) {
    const index = keys.findIndex((key, position) => !used.has(position) && field.names.includes(key));
    if (index >= 0) claim(field.key, index);
  }
  for (const field of fields) {
    if (mapping[field.key] !== null || !field.contains) continue;
    const index = keys.findIndex((key, position) => !used.has(position)
      && field.contains!.some((word) => key.includes(word))
      && !(field.avoid ?? []).some((word) => key.includes(word)));
    if (index >= 0) claim(field.key, index);
  }
  // A real first-name column wins; a full-name column is only for files that have no other name column.
  if (kind === "customers" && mapping.firstName !== null && mapping.fullName !== null) mapping.fullName = null;
  return mapping;
}

function nullIfNone(value: number | null | undefined): number | null {
  return value === undefined ? null : value;
}

/** The required fields the mapping leaves out, by field key. */
export function missingRequiredFields(kind: ImportKind, mapping: ImportMapping): string[] {
  const has = (key: string) => nullIfNone(mapping[key]) !== null;
  const missing: string[] = [];
  if (kind === "customers") {
    if (!has("firstName") && !has("fullName")) missing.push("firstName");
    if (!has("phone")) missing.push("phone");
  } else if (kind === "services") {
    if (!has("name")) missing.push("name");
    if (!has("durationMinutes")) missing.push("durationMinutes");
  } else {
    if (!has("customerPhone") && !has("customerEmail")) missing.push("customerPhone");
    for (const key of ["service", "staff", "startsAt"]) if (!has(key)) missing.push(key);
  }
  return missing;
}

/** The mapped fields of one row as text. Unmapped fields are left out. A full-name column is split at its last space. */
export function applyMapping(row: readonly string[], mapping: ImportMapping, kind: ImportKind): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of importFields[kind]) {
    const index = nullIfNone(mapping[field.key]);
    if (index !== null) values[field.key] = (row[index] ?? "").trim();
  }
  if (kind === "customers" && values.fullName !== undefined) {
    const full = values.fullName.replace(/\s+/g, " ");
    delete values.fullName;
    if (nullIfNone(mapping.firstName) === null) {
      const cut = full.lastIndexOf(" ");
      const hasLast = nullIfNone(mapping.lastName) !== null;
      values.firstName = !hasLast && cut > 0 ? full.slice(0, cut) : full;
      if (!hasLast) values.lastName = cut > 0 ? full.slice(cut + 1) : "";
    }
  }
  return values;
}
