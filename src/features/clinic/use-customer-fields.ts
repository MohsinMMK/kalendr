"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { toastManager } from "@/components/ui/toast";
import type { CustomerFieldDefinition } from "@/lib/customer-contracts";

import { errorText } from "./customer-parts";
import { customerKeys, useFieldDefinitions, useFieldValueMap, type FieldValueMap } from "./queries/customers";
import { staffMutation } from "./queries/http";
import { useStaffAccess } from "./staff-access";

const noDefinitions: CustomerFieldDefinition[] = [];
const noValues: FieldValueMap = {};

/**
 * The business's own customer fields and everyone's answers, for the Customers table. Off (nothing loaded) when the table
 * runs on preview data, which has no database to keep them in.
 */
export function useCustomerFields(live: boolean) {
  const client = useQueryClient();
  const access = useStaffAccess();
  const definitionsQuery = useFieldDefinitions(live);
  const valuesQuery = useFieldValueMap(live);
  const definitions = definitionsQuery.data ?? noDefinitions;
  const values = valuesQuery.data ?? noValues;

  /** Saves one answer (an empty string clears it) and shows it at once. Rejects with the server's own sentence when refused. */
  const saveValue = useCallback(async (customerId: string, fieldId: string, value: string) => {
    try {
      await staffMutation(`/api/staff/customers/${encodeURIComponent(customerId)}/fields`, "PUT", { values: { [fieldId]: value === "" ? null : value } });
    } catch (cause: unknown) {
      const message = errorText(cause, "The answer could not be saved. Try again.");
      toastManager.add({ title: "Not saved", description: message, type: "error" });
      throw cause;
    }
    await client.invalidateQueries({ queryKey: customerKeys.allFieldValues() });
    await client.invalidateQueries({ queryKey: customerKeys.fieldValues(customerId) });
  }, [client]);

  /** Renames a field of the business's own: the name belongs to the field, not to the table layout. */
  const renameField = useCallback(async (definition: CustomerFieldDefinition, label: string) => {
    const next = label.trim();
    if (!next || next === definition.label) return;
    try {
      await staffMutation(`/api/staff/customer-fields/${encodeURIComponent(definition.id)}`, "PATCH", { label: next, version: definition.version });
      await client.invalidateQueries({ queryKey: customerKeys.fields() });
    } catch (cause: unknown) {
      toastManager.add({ title: "The field was not renamed", description: errorText(cause, "Try again."), type: "error" });
    }
  }, [client]);

  return useMemo(() => ({
    definitions,
    values,
    /** True once the fields are known, so a layout is never arranged against a half-loaded list. */
    ready: !live || definitionsQuery.isSuccess,
    canEditValues: live && access.can("customers.manage"),
    /** Defining, renaming, editing and deleting fields is for owners and admins. */
    canDefine: live && (access.role === "owner" || access.role === "admin") && access.can("customers.manage"),
    saveValue,
    renameField,
  }), [access, definitions, definitionsQuery.isSuccess, live, saveValue, renameField, values]);
}
