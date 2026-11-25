/** Razorpay's own Checkout.js. Added to the page only when someone pays with Razorpay, and only once per page. */
const razorpayScriptUrl = "https://checkout.razorpay.com/v1/checkout.js";

let loading: Promise<void> | undefined;

/** Loads Checkout.js once, for the booking page and for plan billing alike. A failed load can be tried again. */
export function loadRazorpayScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("No window."));
  if (Reflect.get(window, "Razorpay")) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = razorpayScriptUrl;
    script.async = true;
    // With 'strict-dynamic' this script is trusted because our own nonced bundle adds it. Browsers that
    // ignore 'strict-dynamic' use the nonce (copied from a script the server rendered) or the listed host.
    const nonce = document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce;
    if (nonce) script.nonce = nonce;
    script.onload = () => resolve();
    script.onerror = () => {
      script.remove();
      loading = undefined;
      reject(new Error("The payment window could not load."));
    };
    document.head.appendChild(script);
  });
  return loading;
}
