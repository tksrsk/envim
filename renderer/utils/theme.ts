import React from "react";
import { ActionIcon, Button, CloseButton, createTheme, DEFAULT_THEME, defaultVariantColorsResolver, Menu, parseThemeColor, UnstyledButton } from "@mantine/core";

import { uiIcons } from "renderer/utils/icons";

// Clicking chrome buttons must not take focus away from the Neovim input.
const keepFocus = { onMouseDown: (e: React.MouseEvent) => e.preventDefault() };

export const theme = createTheme({
  fontFamily: `"Icon", "Git", ${DEFAULT_THEME.fontFamily}`,
  fontFamilyMonospace: `"Regular", "Icon", "Git", monospace`,
  primaryColor: "blue",
  defaultRadius: "sm",
  fontSizes: { xs: "11px", sm: "12px", md: "13px", lg: "15px", xl: "17px" },
  colors: {
    dark: ["#c1c2c5", "#a6a7ab", "#909296", "#5c5f66", "#373a40", "#2c2e33", "#25262b", "#1a1b1e", "#141517", "#101113"],
  },
  // The default subtle/light text is almost white in dark mode; keep the hue visible.
  variantColorResolver: input => {
    const colors = defaultVariantColorsResolver(input);
    const parsed = parseThemeColor({ color: input.color || input.theme.primaryColor, theme: input.theme });

    if (!["subtle", "light"].includes(input.variant) || !parsed.isThemeColor) return colors;

    return parsed.color === "gray"
      ? { ...colors, color: "var(--mantine-color-dimmed)", hover: "var(--mantine-color-default-hover)" }
      : { ...colors, color: `var(--mantine-color-${parsed.color}-text)` };
  },
  components: {
    ActionIcon: ActionIcon.extend({
      defaultProps: { ...keepFocus, variant: "subtle", color: "gray", size: "var(--envim-control-size)" },
      styles: { root: { fontSize: "inherit", flexShrink: 0, alignSelf: "center" } },
    }),
    CloseButton: CloseButton.extend({
      defaultProps: { size: "var(--envim-control-size)", icon: React.createElement("i", null, uiIcons.close) },
      styles: { root: { fontSize: "inherit", flexShrink: 0, alignSelf: "center" } },
    }),
    Menu: Menu.extend({
      styles: { item: { fontSize: "var(--mantine-font-size-md)" } },
    }),
    Button: Button.extend({ defaultProps: keepFocus }),
    UnstyledButton: UnstyledButton.extend({ defaultProps: keepFocus }),
  },
});
