import type { ImportKind } from "./contracts";

/** Small example files with obviously made-up people. The columns are the ones the screen guesses best. */

const samples: Record<ImportKind, string> = {
  customers: [
    "First name,Last name,Mobile,Email,Date of birth,Preferred channel,Agreed to text messages",
    "Asha,Example,98765 43210,asha.example@example.com,14/03/1990,email,no",
    "Ravi,Sample,+91 91234 56780,ravi.sample@example.com,02/11/1985,sms,no",
    "Meera,Demo,09876501234,,21/07/2001,phone,no",
  ].join("\r\n"),
  services: [
    "Name,Duration,Price,Category,Description",
    "Consultation,30,Rs 500,General,A first conversation about what you need",
    "Follow-up visit,15,300,General,A short check after a treatment",
    "Full session,1h 30m,From 1500,Treatments,A long session",
  ].join("\r\n"),
  appointments: [
    "Phone,Service,Staff,Date,Time",
    "98765 43210,Consultation,Example Staff,15/03/2027,10:30",
    "+91 91234 56780,Follow-up visit,Example Staff,15/03/2027,2:00 pm",
  ].join("\r\n"),
};

export const sampleFor = (kind: ImportKind): string => `﻿${samples[kind]}\r\n`;
