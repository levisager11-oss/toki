import { useEffect } from "react";

/** Sets the browser tab title to "<title> · Toki" while the page is open. Nothing (null/empty) shows just "Toki". */
export function useTitle(title: string | null | undefined) {
  useEffect(() => {
    document.title = title ? `${title} · Toki` : "Toki";
    return () => {
      document.title = "Toki";
    };
  }, [title]);
}
