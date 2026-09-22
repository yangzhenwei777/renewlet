import {
  clearProductSessionForSnapshot,
  type ProductSessionSnapshot,
} from "@/services/product-session";

export function clearAuthSession(snapshot: ProductSessionSnapshot | null) {
  clearProductSessionForSnapshot(snapshot);
}
