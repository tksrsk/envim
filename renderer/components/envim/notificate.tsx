import React from "react";

import { IMessage } from "common/interface";

import { useEditor } from "renderer/context/editor";
import { useWorkspace } from "renderer/context/workspace";


import { FlexComponent } from "renderer/components/flex";
import { MessageComponent } from "renderer/components/envim/message";

interface States {
  messages: IMessage[];
  enabled: boolean;
}

const styles: { [k: string]: React.CSSProperties } = {
  scope: {
    overflow: "hidden auto",
    width: 300,
    maxHeight: "100%",
  },
  messages: {
    overflow: "hidden auto",
  },
};

export function NotificateComponent() {
  const { options } = useEditor();
  const { emit } = useWorkspace();
  const [state, setState] = React.useState<States>({ messages: [], enabled: options.ext_messages });

  React.useEffect(() => {
    emit.on("messages:show", onShow);

    return () => {
      emit.off("messages:show", onShow);
    };
  }, []);

  function onShow(messages: IMessage[], replace: boolean) {
    setState(state => {
      replace && state.messages.splice(0);

      return {
        ...state,
        messages: [ ...state.messages, ...messages ].reduce(
          (all: IMessage[], curr: IMessage) => {
            const last = all.pop();

            if (last && last.kind === curr.kind) {
              curr.contents = [ ...last.contents, { hl: "0", content: "\n" }, ...curr.contents ];
            } else if (last) {
              all.push(last);
            }

            return [ ...all, curr ];
          },
          []
        )
      };
    });
  }

  React.useEffect(() => {
    options.ext_messages === undefined || setState(state => ({ ...state, enabled: options.ext_messages }));
  }, [options.ext_messages]);

  return state.enabled && state.messages.length > 0 && (
    <FlexComponent direction="column" inset={["auto", 0, 0, "auto"]} position="absolute" style={styles.scope} spacing>
      {state.messages.map((message, i) =>
        <FlexComponent animate="slide-right" margin={[4, 0]} rounded={[4]} style={styles.messages} key={i} shadow><MessageComponent message={message} open /></FlexComponent>
      )}
    </FlexComponent>
  );
}
