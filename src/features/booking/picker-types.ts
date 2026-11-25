import type { TimeSlot } from "@/lib/domain";

/** What the three layouts share. Days are `YYYY-MM-DD` keys in the zone being shown. */
export interface PickerViewProps {
  id: string;
  name: string;
  slotsByDay: Map<string, TimeSlot[]>;
  zone: string;
  locale: string;
  hour12?: boolean;
  weekStartsOn: 0 | 1;
  /** Today in the shown zone. */
  today: string;
  /** The last day that can be browsed to. */
  maxDay: string;
  /** Days to cross out as fully booked, in the shown zone. */
  fullDays: Set<string>;
  personNames: Map<string, string>;
  showPractitioner: boolean;
  selectedSlotId?: string;
  /** Week and column: the day the view starts from. */
  anchor: string;
  onAnchorChange: (day: string) => void;
  onChoose: (slot: TimeSlot, viaPointer: boolean) => void;
  describedBy?: string;
  /** More times are on their way for what is on screen. */
  loading: boolean;
}
