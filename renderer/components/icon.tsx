import React from "react";

import { Setting } from "renderer/utils/setting";

import { FlexComponent } from "renderer/components/flex";

interface Props {
  font: string;
  color?: string;
  style?: React.CSSProperties;
  text?: number | string;
  hover?: boolean;
  active?: boolean;
  float?: "left" | "right";
  onClick?: (...args: any[]) => void;
}

const styles: { [k: string]: React.CSSProperties } = {
  text: {
    display: "inline",
    paddingLeft: 4,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
};

export function IconComponent(props: Props) {
  const float = props.float;
  const style = props.style || {};
  const url = props.font.search(/https?:\/\//) === 0;

  if (float) {
    style.transform = "translateY(-50%)";
    style.lineHeight = 1;
    style.top = "50%";
    style[float] = 2;
  }

  return (
    <FlexComponent vertical="center" position={float && "absolute"} rounded={float && [4]} padding={[4]} spacing={!float} shrink={1} style={style} { ...props }>
      { url ? <img src={props.font} height={Setting.font.size} /> : <i>{ props.font }</i> }
      { props.text && <div style={styles.text}>{ props.text }</div> }
    </FlexComponent>
  );
}
