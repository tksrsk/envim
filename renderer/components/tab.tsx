import React from "react";

import { FlexComponent } from "renderer/components/flex";
import { IconComponent } from "renderer/components/icon";
import { uiIcons } from "renderer/utils/icons";

const envimIconUrl = new URL("../../assets/envim-icon.png", import.meta.url).href;

type WorkspaceTabProps = Pick<React.ComponentProps<typeof FlexComponent>,
  "active" | "color" | "title" | "onClick" | "onDragStart" | "onDragOver" | "onDragEnd" | "onDrop"
> & {
  font: string;
  glyph?: React.ReactNode;
  text: string;
  onClose?: React.MouseEventHandler;
};

export function WorkspaceTabComponent({ font, glyph, text, onClose, ...props }: WorkspaceTabProps) {
  const { active } = props;
  return (
    <FlexComponent {...props} animate="fade-in hover" shrink={active ? 0 : 2} margin={[4, 2, 0]} padding={[0, 8]}
      rounded={[4, 4, 0, 0]} shadow={active} style={{ width: 150, minWidth: "2rem", cursor: "pointer" }}>
      <IconComponent font={font} glyph={glyph} text={text} />
      {onClose && <IconComponent color="gray" font={uiIcons.close} float="right" onClick={onClose} hover />}
    </FlexComponent>
  );
}

export function SurfaceSwitchComponent({ onClick }: { onClick: () => void }) {
  return (
    <IconComponent font="" glyph={<img src={envimIconUrl} alt="" style={{ width: "1.45em", height: "1.45em" }} />} onClick={onClick} />
  );
}
