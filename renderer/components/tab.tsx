import React from "react";
import { ActionIcon, Box, CloseButton, Group, Text } from "@mantine/core";

const envimIconUrl = new URL("../../assets/envim-icon.png", import.meta.url).href;

type WorkspaceTabProps = Pick<React.ComponentProps<"div">,
  "title" | "onClick" | "onDragStart" | "onDragOver" | "onDragEnd" | "onDrop"
> & {
  active?: boolean;
  badge?: React.ReactNode;
  color?: string;
  font: string;
  glyph?: React.ReactNode;
  text: string;
  onClose?: React.MouseEventHandler;
};

export function WorkspaceTabComponent({ font, glyph, text, onClose, active, badge, color, ...props }: WorkspaceTabProps) {
  return (
    <div {...props} className="animate fade-in hover workspace-tab" data-active={active || undefined} draggable={!!props.onDragStart}>
      <Group gap={4} wrap="nowrap" px={4} miw={0}>{glyph ?? <Box component="i" c={color}>{font}</Box>}<Text component="span" inherit truncate>{text}</Text>{badge}</Group>
      {onClose && <CloseButton className="contents workspace-tab-close" onClick={onClose} />}
    </div>
  );
}

export function SurfaceSwitchComponent({ onClick }: { onClick: () => void }) {
  return (
    <ActionIcon onClick={onClick}><img src={envimIconUrl} alt="" style={{ width: "1.45em", height: "1.45em" }} /></ActionIcon>
  );
}
