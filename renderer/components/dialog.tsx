import React from "react";

import { uiIcons } from "renderer/utils/icons";

import { FlexComponent } from "renderer/components/flex";
import { IconComponent } from "renderer/components/icon";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function DialogComponent(props: React.PropsWithChildren<Props>) {
  const ref = React.useRef<HTMLDialogElement>(null);

  React.useEffect(() => {
    props.open ? ref.current?.showModal() : ref.current?.close();
  }, [props.open]);

  return (
    <dialog className="animate fade-in color-default" ref={ref} onClose={props.onClose}>
      <FlexComponent position="absolute" inset={[8, 8, "auto", "auto"]}>
        <IconComponent color="gray-fg" font={uiIcons.close} onClick={props.onClose} />
      </FlexComponent>
      {props.children}
    </dialog>
  );
}
