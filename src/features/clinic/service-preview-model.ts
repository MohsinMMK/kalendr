import type { Service } from "@/lib/domain";
import type { ServiceFormValues } from "./service-editor-model";

/**
 * The service as the booking page would show it, built from the editor's unsaved values. `base` is the saved row
 * (for the picture and ids); everything the customer reads is taken from the form, so typing shows at once.
 */
export function previewServiceFrom(values: Partial<ServiceFormValues>, base: Service): Service {
  const lengths = values.lengths?.length ? values.lengths : base.lengths;
  const usual = lengths?.find((length) => length.isDefault) ?? lengths?.[0];
  return {
    ...base,
    name: values.basics?.name?.trim() || base.name,
    description: values.basics?.description ?? base.description,
    ...(values.basics?.category !== undefined ? { category: values.basics.category ?? undefined } : {}),
    bookingMode: values.basics?.bookingMode ?? base.bookingMode,
    durationMinutes: usual?.minutes ?? base.durationMinutes,
    ...(lengths ? { lengths: lengths.map((length) => ({ ...length })) } : {}),
    ...(values.locationOptions?.length ? { locationOptions: values.locationOptions } : {}),
    ...(values.look ? { colorLight: values.look.colorLight, colorDark: values.look.colorDark } : {}),
    ...(values.basics ? { visibility: values.basics.visibility, isActive: values.basics.isActive } : {}),
  };
}
