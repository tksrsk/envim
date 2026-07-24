import React from "react";
import { createPortal } from "react-dom";

import { FlexComponent } from "renderer/components/flex";

interface Props {
  side?: boolean;
  horizontal?: boolean;
  label: string | React.ComponentType;
  color?: string;
  active?: boolean;
  fit?: boolean;
}

interface States {
  position: {
    top?: number,
    right?: number,
    bottom?: number,
    left?: number
  } | null;
}

const styles: { [k: string]: React.CSSProperties } = {
  wrap: {
    position: "relative",
    display: "flex",
    width: "100%",
    height: "100%",
  },
  menu: {
    lineHeight: 1.5,
    whiteSpace: "nowrap",
    overflowY: "auto",
    overflowX: "hidden",
  },
  sidemenu: {
    lineHeight: 1.5,
    whiteSpace: "nowrap",
    overflowY: "auto",
    overflowX: "hidden",
  },
};

export function MenuComponent(props: React.PropsWithChildren<Props>) {
  const [state, setState] = React.useState<States>({ position: null });
  const timer: React.RefObject<number> = React.useRef<number>(0);
  const div: React.RefObject<HTMLDivElement | null> = React.useRef<HTMLDivElement>(null);

  function onClick() { }

  function onMouseEnter() {
    clearTimeout(timer.current);
    timer.current = +setTimeout(() => setState(() => {
      const haschild = !(Array.isArray(props.children) && props.children.length === 0);

      if (!haschild || !div.current) return { position: null };

      const rect = div.current.getBoundingClientRect();
      const vert = window.innerHeight / 2 < rect.top ? "top" : "bottom";
      const hori = window.innerWidth / 2 < rect.left ? "left" : "right";
      const position: States["position"] = {};

      if (props.side) {
        vert === "bottom" ? position.top = rect.top : position.bottom = window.innerHeight - rect.bottom;
        hori === "left" ? position.right = window.innerWidth - rect.left : position.left = rect.right;
      } else {
        vert === "bottom" ? position.top = rect.bottom : position.bottom = window.innerHeight - rect.top;
        hori === "left" ? position.right = window.innerWidth - rect.right : position.left = rect.left;
      }

      return { position };
    }), 200);
  }

  function onMouseLeave() {
    clearTimeout(timer.current);
    timer.current = +setTimeout(() => setState({ position: null }), 200);
  }

  function renderMenu() {
    if (!state.position) return null;

    const base = props.side ? styles.sidemenu : styles.menu;
    const style = { ...base, ...state.position, maxWidth: window.innerWidth / 2, maxHeight: window.innerHeight / 2, minWidth: Math.min(props.fit ? 0 : 150, window.innerWidth / 2 - 20) };
    const direction = props.horizontal ? "row" : "column";

    return createPortal((
      <FlexComponent color="default" animate="fade-in" direction={direction} position="fixed" zIndex={20} rounded={[2]} style={style} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} shadow>
        { props.children }
      </FlexComponent>
    ), document.getElementById("theme") || document.body);
  }

  return (
    <FlexComponent vertical="center">
      <div className="space" style={styles.wrap} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} ref={div}>
        <FlexComponent grow={1} vertical="center" color={props.color} onClick={onClick} active={props.active} spacing={typeof props.label === "string"}>
          { typeof props.label === "string" ? props.label : <props.label /> }
        </FlexComponent>
        { renderMenu() }
      </div>
    </FlexComponent>
  );
}
