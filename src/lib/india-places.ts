export interface IndiaPlace {
  id: string;
  state: string;
  city: string;
  landmark?: string;
  image?: string;
}

export const featuredPlaces: IndiaPlace[] = [
  { id: "telangana", state: "Telangana", city: "Hyderabad", landmark: "Charminar", image: "/onboarding/telangana-charminar.webp" },
  { id: "karnataka", state: "Karnataka", city: "Bengaluru", landmark: "Vidhana Soudha", image: "/onboarding/karnataka-vidhana.webp" },
  { id: "maharashtra", state: "Maharashtra", city: "Mumbai", landmark: "Gateway of India", image: "/onboarding/maharashtra-gateway.webp" },
  { id: "delhi", state: "Delhi", city: "New Delhi", landmark: "India Gate", image: "/onboarding/delhi-india-gate.webp" },
  { id: "tamil-nadu", state: "Tamil Nadu", city: "Chennai", landmark: "Shore Temple", image: "/onboarding/tamil-nadu-shore-temple.webp" },
  { id: "rajasthan", state: "Rajasthan", city: "Jaipur", landmark: "Hawa Mahal", image: "/onboarding/rajasthan-hawa-mahal.webp" },
];

const otherPlaces: IndiaPlace[] = [
  { id: "andaman-nicobar", state: "Andaman and Nicobar Islands", city: "Sri Vijaya Puram" },
  { id: "dadra-nagar-haveli-daman-diu", state: "Dadra and Nagar Haveli and Daman and Diu", city: "Daman" },
  { id: "lakshadweep", state: "Lakshadweep", city: "Kavaratti" },
  { id: "andhra-pradesh", state: "Andhra Pradesh", city: "Visakhapatnam" },
  { id: "arunachal-pradesh", state: "Arunachal Pradesh", city: "Itanagar" },
  { id: "assam", state: "Assam", city: "Guwahati" },
  { id: "bihar", state: "Bihar", city: "Patna" },
  { id: "chhattisgarh", state: "Chhattisgarh", city: "Raipur" },
  { id: "goa", state: "Goa", city: "Panaji" },
  { id: "gujarat", state: "Gujarat", city: "Ahmedabad" },
  { id: "haryana", state: "Haryana", city: "Gurugram" },
  { id: "himachal-pradesh", state: "Himachal Pradesh", city: "Shimla" },
  { id: "jharkhand", state: "Jharkhand", city: "Ranchi" },
  { id: "kerala", state: "Kerala", city: "Kochi" },
  { id: "madhya-pradesh", state: "Madhya Pradesh", city: "Bhopal" },
  { id: "manipur", state: "Manipur", city: "Imphal" },
  { id: "meghalaya", state: "Meghalaya", city: "Shillong" },
  { id: "mizoram", state: "Mizoram", city: "Aizawl" },
  { id: "nagaland", state: "Nagaland", city: "Kohima" },
  { id: "odisha", state: "Odisha", city: "Bhubaneswar" },
  { id: "punjab", state: "Punjab", city: "Chandigarh" },
  { id: "sikkim", state: "Sikkim", city: "Gangtok" },
  { id: "tripura", state: "Tripura", city: "Agartala" },
  { id: "uttar-pradesh", state: "Uttar Pradesh", city: "Lucknow" },
  { id: "uttarakhand", state: "Uttarakhand", city: "Dehradun" },
  { id: "west-bengal", state: "West Bengal", city: "Kolkata" },
  { id: "jammu-kashmir", state: "Jammu and Kashmir", city: "Srinagar" },
  { id: "ladakh", state: "Ladakh", city: "Leh" },
  { id: "puducherry", state: "Puducherry", city: "Puducherry" },
  { id: "chandigarh", state: "Chandigarh", city: "Chandigarh" },
];

export const indianPlaces: IndiaPlace[] = [...featuredPlaces, ...otherPlaces]
  .sort((left, right) => left.state.localeCompare(right.state));

export function filterIndiaPlaces(query: string): IndiaPlace[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return featuredPlaces;
  return indianPlaces.filter((place) =>
    [place.state, place.city, place.landmark ?? ""].some((value) => value.toLowerCase().includes(needle)),
  );
}
