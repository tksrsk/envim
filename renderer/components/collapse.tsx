import React from "react";
import { Accordion, Group, Text } from "@mantine/core";

interface Props {
  label: string;
  open?: boolean;
  icon?: React.ReactNode;
  badge?: string | React.ComponentType;
  variant?: "card" | "row";
  style?: React.CSSProperties;
}

export function CollapseComponent({ label, open, icon, badge: Badge, variant = "card", style, children }: React.PropsWithChildren<Props>) {
  return (
    <Accordion className={`envim-collapse envim-collapse-${variant}`} variant={variant === "card" ? "contained" : "default"} radius="sm"
      chevronPosition={variant === "card" ? "left" : "right"} chevronSize={10} chevronIconSize={10} defaultValue={open ? "item" : null} keepMounted={false} style={style}
    >
      <Accordion.Item value="item">
        <Accordion.Control icon={icon}>
          <Group gap={4} wrap="nowrap">
            <Text component="span" inherit truncate flex={1} miw={0}>{label}</Text>
            {Badge && (typeof Badge === "string" ? Badge : <Badge />)}
          </Group>
        </Accordion.Control>
        <Accordion.Panel>{children}</Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}
