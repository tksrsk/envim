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
  mark?: boolean;
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
  mark: {
    display: "inline-block",
    height: "100%",
    background: "var(--color-fg)",
    maskPosition: "center",
    maskSize: "contain",
    maskRepeat: "no-repeat",
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

  const icon = (() => {
    if (props.mark) return <i style={{ ...styles.mark, maskImage: `url(${props.font})` }} />;
    if (url) return <img src={props.font} height={Setting.font.size} />;
    return <i>{ props.font }</i>;
  })();

  return (
    <FlexComponent vertical="center" position={float && "absolute"} rounded={float && [4]} padding={[4]} spacing={!float} shrink={1} style={style} { ...props }>
      { icon }
      { props.text && <div style={styles.text}>{ props.text }</div> }
    </FlexComponent>
  );
}
