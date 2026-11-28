import { Button } from "@mantine/core";

import { IElicitationRequest } from "common/interface";
import { IFormRequest, IFormSchema } from "common/schema";

import { uiIcons } from "renderer/utils/icons";

import { useWorkspace } from "renderer/context/workspace";

export function ElicitationComponent({ request }: { request: IElicitationRequest }) {
  const { emit } = useWorkspace();
  const { params, requestId } = request;

  function onOpen() {
    emit.share("form:open", {
      title: "󰋗 Elicitation", message: params.message,
      url: params.mode === "url" ? params.url : undefined,
      schema: params.mode === "form" ? params.requestedSchema as IFormSchema : undefined,
      actions: [
        { action: "accept", name: "Accept", color: "green", font: uiIcons.accept, submit: true },
        { action: "decline", name: "Decline", color: "red", font: uiIcons.decline },
        { action: "cancel", name: "Cancel", color: "gray", font: uiIcons.close },
      ],
      reply: { event: "acp:elicitation:response", via: "send", args: [requestId] },
    } satisfies IFormRequest);
  }

  return (
    <Button variant="light" color="orange" size="xs" fullWidth leftSection={<i>󰋗</i>} onClick={onOpen}>
      Agent is asking for input
    </Button>
  );
}
