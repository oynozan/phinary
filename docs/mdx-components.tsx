import { useMDXComponents as getThemeComponents } from "nextra-theme-docs";
import type { MDXComponents } from "nextra/mdx-components";

import { Source } from "./components/source";

const themeComponents = getThemeComponents();

export function useMDXComponents(components?: MDXComponents) {
    return { ...themeComponents, Source, ...components };
}
