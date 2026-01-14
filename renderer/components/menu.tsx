import React, { useState, useRef, PropsWithChildren, RefObject } from "react";

import { FlexComponent } from "./flex";

interface Props {
  side?: boolean;
  horizontal?: boolean;
  label: string | React.ComponentType;
  color?: string;
  active?: boolean;
  fit?: boolean;
}

interface States {
  inset: (0 | "100%" | "auto")[];
}

const position: "relative" = "relative";
const whiteSpace: "nowrap" = "nowrap";
const styles = {
  wrap: {
    position,
    display: "flex",
    width: "100%",
    height: "100%",
  },
  menu: {
    minWidth: "100%",
    lineHeight: 1.5,
    whiteSpace,
  },
  sidemenu: {
    lineHeight: 1.5,
    whiteSpace,
  },
};

export function MenuComponent(props: PropsWithChildren<Props>) {
  const [state, setState] = useState<States>({ inset: [] });
  const timer: RefObject<number> = useRef<number>(0);
  const div: RefObject<HTMLDivElement | null> = useRef<HTMLDivElement>(null);

  function onClick() { }

  function onMouseEnter() {
    clearTimeout(timer.current);
    timer.current = +setTimeout(() => setState(() => {
      const haschild = !(Array.isArray(props.children) && props.children.length === 0);
      const inset: (0 | "100%" | "auto")[] = haschild ? ["auto", "auto", "auto", "auto"] : [];

      if (haschild && div.current) {
        const { top, left } = div.current.getBoundingClientRect();
        const vert = window.innerHeight / 2 < top ? "top" : "bottom";
        const hori = window.innerWidth / 2 < left ? "left" : "right";

        if (vert === "bottom") {
          inset[0] = props.side ? 0 : "100%";
        }
        if (hori === "left") {
          inset[1] = props.side ? "100%" : 0;
        }
        if (vert === "top") {
          inset[2] = props.side ? 0 : "100%";
        }
        if (hori === "right") {
          inset[3] = props.side ? "100%" : 0;
        }
      }

      return { ...state, inset };
    }), 200);
  }

  function onMouseLeave() {
    clearTimeout(timer.current);
    timer.current = +setTimeout(() => setState(state => ({ ...state, inset: [] })), 200);
  }

  function renderMenu() {
    if (state.inset.length === 0) return null;

    const base = props.side ? styles.sidemenu : styles.menu;
    const style = { ...base, ...{ inset: state.inset.join(" "), maxWidth: window.innerWidth - 20, minWidth: Math.min(props.fit ? 0 : 150, window.innerWidth / 2 - 20) } };
    const direction = props.horizontal ? "row" : "column";

    return (
      <FlexComponent color="default" animate="fade-in" direction={direction} position="absolute" overflow="visible" zIndex={20} rounded={[2]} style={style} shadow>
        { props.children }
      </FlexComponent>
    );
  }

  return (
    <FlexComponent vertical="center" overflow="visible">
      <div className="space" style={styles.wrap} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} ref={div}>
        <FlexComponent grow={1} vertical="center" color={props.color} onClick={onClick} active={props.active} spacing={typeof props.label === "string"}>
          { typeof props.label === "string" ? props.label : <props.label /> }
        </FlexComponent>
        { renderMenu() }
      </div>
    </FlexComponent>
  );
}
