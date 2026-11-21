import type { ReactNode } from "react";

// A second root layout without a provider, so each route's chunks hold only what the route imports.
export default function AliasLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="no">
      <body>{children}</body>
    </html>
  );
}
