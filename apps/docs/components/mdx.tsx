import * as Twoslash from "fumadocs-twoslash/ui";
import { createGenerator } from "fumadocs-typescript";
import { AutoTypeTable, type AutoTypeTableProps } from "fumadocs-typescript/ui";
import { Accordion, Accordions } from "fumadocs-ui/components/accordion";
import { Step, Steps } from "fumadocs-ui/components/steps";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import { TypeTable } from "fumadocs-ui/components/type-table";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { RoutesTable } from "./routes-table";

/**
 * Reads the SDK's real types at build time for `<AutoTypeTable>`. Paths in the MDX resolve from
 * the docs app's root; the SDK's own tsconfig resolves its imports.
 */
const generator = createGenerator({ tsconfigPath: "../../packages/sdk/tsconfig.json" });

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    ...Twoslash,
    Accordion,
    Accordions,
    Step,
    Steps,
    Tab,
    Tabs,
    TypeTable,
    AutoTypeTable: (props: Omit<AutoTypeTableProps, "generator">) => (
      <AutoTypeTable {...props} generator={generator} />
    ),
    RoutesTable,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
