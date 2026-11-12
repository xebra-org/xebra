import { XebraMark } from "@/components/mark";
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { gitConfig } from "./shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="flex items-center gap-2.5">
          <XebraMark className="size-5" />
          <span className="font-semibold tracking-[-0.02em]">Xebra</span>
          <span className="text-fd-muted-foreground font-normal">Docs</span>
        </span>
      ),
    },
    links: [
      { text: "Guides", url: "/docs/guides", active: "nested-url" },
      { text: "API", url: "/docs/api", active: "nested-url" },
      { text: "SDK", url: "/docs/sdk", active: "nested-url" },
      { text: "xebra.exchange", url: "https://xebra.exchange", external: true },
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
