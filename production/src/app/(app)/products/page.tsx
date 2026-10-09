import { redirect } from "next/navigation";

/**
 * R-490 (R-472): the Sales menu calls the catalogue "Products", so people type /products —
 * which was a 404. The page lives at /items; send them there.
 */
export default function ProductsRedirect(): never {
  redirect("/items");
}
