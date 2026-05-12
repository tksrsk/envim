import React, { PropsWithChildren } from "react";

import { FlexComponent } from "./flex";

interface Props {
  label: string;
  open?: boolean;
  badge?: string | React.ComponentType;
  style?: React.CSSProperties;
}

const styles = {
  text: {
    display: "inline",
    paddingRight: 4,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
};

export function CollapseComponent(props: PropsWithChildren<Props>) {
  return (
    <details style={props.style} open={props.open}>
      <summary className="clickable">
        <FlexComponent vertical="center" whiteSpace="pre-wrap">
          <div style={styles.text}>{props.label}</div>
          <div className="space" />
          { props.badge && (<FlexComponent>{typeof props.badge === "string" ? props.badge : <props.badge />}</FlexComponent>) }
        </FlexComponent>
      </summary>
      <FlexComponent direction="column" padding={[4]}>
        {props.children}
      </FlexComponent>
    </details>
  );
}
