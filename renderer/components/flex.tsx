import React from "react";

interface Props {
  selectable?: boolean;
  animate?: string;
  hover?: boolean;
  color?: string;
  active?: boolean;
  title?: string;

  onClick?: (e: React.MouseEvent) => void;
  onMouseDown?: (e: React.MouseEvent) => void;
  onMouseMove?: (e: React.MouseEvent) => void;
  onMouseUp?: (e: React.MouseEvent) => void;
  onMouseEnter?: (e: React.MouseEvent) => void;
  onMouseLeave?: (e: React.MouseEvent) => void;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  onWheel?: (e: React.WheelEvent) => void;
  onScroll?: (e: React.UIEvent) => void;

  direction?: "row" | "column" | "row-reverse" | "column-reverse";
  shadow?: boolean;
  grow?: number;
  shrink?: number;
  basis?: "auto" | "0";
  vertical?: "stretch" | "start" | "center" | "end";
  horizontal?: "stretch" | "start" | "center" | "end";
  spacing?: boolean;
  inset?: (number | "auto")[];
  margin?: (number | "auto")[];
  padding?: number[];
  border?: number[];
  rounded?: number[];
  position?: "relative" | "absolute" | "sticky" | "fixed";
  overflow?: "hidden" | "auto" | "visible";
  wordBreak?: "break-all";
  whiteSpace?: "nowrap" | "pre-wrap";
  nomouse?: boolean;
  zIndex?: number;
  style?: React.CSSProperties;
}

export function FlexComponent(props: React.PropsWithChildren<Props>)  {
  function getClassName() {
    const classes: string[] = [];

    props.selectable && classes.push("selectable");
    props.animate && classes.push(`animate ${props.animate}`);
    props.hover && classes.push("contents");
    props.color && classes.push(`color-${props.color}`);
    props.active && classes.push("active");
    props.onClick && classes.push("clickable");

    return classes.join(" ");
  }

  function getStyle() {
    return {
      display: "flex",
      borderStyle: "solid",
      flexDirection: props.direction || "row",
      flexGrow: props.grow || 0,
      flexShrink: props.shrink || 0,
      flexBasis: props.basis || "auto",
      alignItems: props.vertical || "stretch",
      justifyContent: props.horizontal || "stretch",
      boxShadow: props.shadow ? "rgba(0, 0, 0, 0.2) 0 0 2px 2px" : "none",
      padding: (props.spacing ? [0, 4] : props.padding || [0]).map(px => `${px}px`).join(" "),
      inset: (props.inset || ["auto"]).map(px => px === "auto" ? "auto" : `${px}px`).join(" "),
      margin: (props.margin || [0]).map(px => px === "auto" ? "auto" : `${px}px`).join(" "),
      borderWidth: (props.border || [0]).map(px => `${px}px`).join(" "),
      borderRadius: (props.rounded || [0]).map(px => `${px}px`).join(" "),
      position: props.position || "relative",
      overflow: props.overflow || "hidden",
      wordBreak: props.wordBreak || "break-all",
      whiteSpace: props.whiteSpace || "nowrap",
      ...( props.nomouse ? { pointerEvents: "none" as "none" } : {} ),
      ...( props.zIndex !== undefined ? { zIndex: props.zIndex } : {} ),
      ...( props.style || {} )
    };
  }

  return (
    <div
      className={getClassName()}
      title={props.title}
      onClick={props.onClick}
      onMouseDown={props.onMouseDown}
      onMouseMove={props.onMouseMove}
      onMouseUp={props.onMouseUp}
      onMouseEnter={props.onMouseEnter}
      onMouseLeave={props.onMouseLeave}
      onDragStart={props.onDragStart}
      onDragOver={props.onDragOver}
      onDragEnd={props.onDragEnd}
      onDrop={props.onDrop}
      onWheel={props.onWheel}
      onScroll={props.onScroll}
      style={getStyle()}
      draggable={!!(props.onDragStart && props.onDragEnd)}
    >
      { props.children }
    </div>
  );
}
