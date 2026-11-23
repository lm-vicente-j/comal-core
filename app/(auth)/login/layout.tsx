import type { Viewport } from "next";
import type { ReactNode } from "react";

export const viewport: Viewport = {
  interactiveWidget: "resizes-content",
};

export default function LoginLayout({ children }: { children: ReactNode }) {
  return children;
}
