import React from "react";

import { IMessage } from "common/interface";

import { Highlights } from "renderer/utils/highlight";
import { notificates } from "renderer/utils/icons";

import { FlexComponent } from "renderer/components/flex";
import { IconComponent } from "renderer/components/icon";

interface Props {
  message: IMessage;
  open: boolean;
}

interface States {
  open: boolean;
}

const styles: { [k: string]: React.CSSProperties } = {
  message: {
    textOverflow: "ellipsis",
    overflow: "hidden"
  },
  action: {
    height: 1,
  },
};

export function MessageComponent(props: Props) {
  const [state, setState] = React.useState<States>({ open: props.open });
  const { font } = notificates.filter(icon => icon.kinds.indexOf(props.message.kind) >= 0)[0] || { font: "󱈸" };
  const defaultHl = props.message.contents[0].hl;
  const defaultStyle = Highlights.style(defaultHl);

  function onToggleOpen() {
    setState(state => ({ ...state, open: !state.open }));
  }

  function contentStyle(hl: string, style: { [k: string]: string }) {
    return {
      ...(`${hl}`.startsWith("color-") ? { className: hl } : {}),
      style: { ...style, ...(defaultStyle.background === style.background ? { background: "" } : {}) }
    };
  }

  return (
    <FlexComponent grow={1} basis="0" onClick={onToggleOpen}>
      <IconComponent font={font} style={Highlights.style(defaultHl, { reverse: true, normal: true })} />
      <FlexComponent whiteSpace={state.open ? "pre-wrap" : "nowrap"} grow={1} shrink={1} basis="0" padding={[2, 4]} style={defaultStyle} selectable>
        <div style={styles.message}>
          {props.message.contents.map(({hl, content}, i) => <span {...contentStyle(hl, hl === defaultHl ? {} : Highlights.style(hl))} key={i}>{ content }</span>)}
        </div>
      </FlexComponent>
    </FlexComponent>
  );
}
