import React from "react";
import * as AcpSDK from "@agentclientprotocol/sdk";

import { IElicitationRequest } from "common/interface";

import { useWorkspace } from "renderer/context/workspace";

import { FlexComponent } from "renderer/components/flex";
import { IconComponent } from "renderer/components/icon";

type IProperty = { type: string; title?: string | null; description?: string | null; default?: unknown; [k: string]: unknown };

const actions = [
  { action: "accept", name: "Accept", color: "green", font: "" },
  { action: "decline", name: "Decline", color: "red", font: "" },
  { action: "cancel", name: "Cancel", color: "blue", font: "" },
] as const;

const styles: { [k: string]: React.CSSProperties } = {
  action: {
    flexBasis: "100%",
  },
};

export function ElicitationComponent({ request }: { request: IElicitationRequest }) {
  const { emit } = useWorkspace();
  const form = React.useRef<HTMLFormElement>(null);
  const { params } = request;
  const schema = params.mode === "form" ? params.requestedSchema : undefined;
  const url = params.mode === "url" ? params.url : "";
  const properties = Object.entries(schema?.properties || {}) as [string, IProperty][];

  function onResponse(response: AcpSDK.CreateElicitationResponse) {
    emit.send("acp:elicitation:response", request.requestId, response);
  }

  function onAction(action: typeof actions[number]["action"]) {
    if (action !== "accept" || !form.current) return onResponse({ action });
    if (!form.current.reportValidity()) return;

    const data = new FormData(form.current);
    const content = Object.fromEntries(properties.flatMap(([key, property]): [string, AcpSDK.ElicitationContentValue][] => {
      const values = data.getAll(key).map(String);

      switch (property.type) {
        case "boolean": return [[key, values.length > 0]];
        case "array": return [[key, values]];
        case "number":
        case "integer": return values[0] ? [[key, Number(values[0])]] : [];
        default: return values[0] ? [[key, values[0]]] : [];
      }
    }));

    onResponse({ action: "accept", content });
  }

  function getOptions(property: IProperty) {
    const items = (property.type === "array" ? property.items : property) as { oneOf?: AcpSDK.EnumOption[] | null; anyOf?: AcpSDK.EnumOption[]; enum?: string[] | null } | undefined;
    const options = items?.oneOf || items?.anyOf || items?.enum?.map(value => ({ const: value, title: value }));

    return options?.map(option => ({ value: option.const, title: option.title }));
  }

  function renderInput(key: string, property: IProperty, required: boolean) {
    const options = getOptions(property);

    switch (property.type) {
      case "boolean":
        return <label><input type="checkbox" name={key} defaultChecked={!!property.default} />{property.title || key}</label>;
      case "number":
      case "integer":
        return <input type="number" name={key} step={property.type === "integer" ? 1 : "any"} min={property.minimum as number} max={property.maximum as number} defaultValue={property.default as number} required={required} />;
    }

    if (options) {
      const type = property.type === "array" ? "checkbox" : "radio";
      const selected = ([] as unknown[]).concat(property.default);

      return (
        <FlexComponent direction="column" whiteSpace="pre-wrap">
          {type === "radio" && !required && <label><input type="radio" name={key} value="" defaultChecked={!property.default} />Not select</label>}
          {options.map(option => (
            <label key={option.value}><input type={type} name={key} value={option.value} defaultChecked={selected.includes(option.value)} required={type === "radio" && required} />{option.title}</label>
          ))}
        </FlexComponent>
      );
    }

    return <input type="text" name={key} minLength={property.minLength as number} maxLength={property.maxLength as number} pattern={property.pattern as string} placeholder={property.format as string} defaultValue={property.default as string} required={required} />;
  }

  return (
    <FlexComponent direction="column" padding={[4]} whiteSpace="pre-wrap">
      <span>{params.message}</span>
      {url && <FlexComponent color="orange-fg" title={url}>{new URL(url).host}</FlexComponent>}
      {schema && (
        <form ref={form} onKeyDown={e => e.key === "Enter" && !e.nativeEvent.isComposing && e.preventDefault()} onFocus={() => emit.share("ui:focused")}>
          {properties.map(([key, property]) => (
            <FlexComponent key={key} direction="column" padding={[4, 0]} whiteSpace="pre-wrap">
              {property.type !== "boolean" && <span>{property.title || key}{schema.required?.includes(key) && " *"}</span>}
              {property.description && <span className="color-gray-fg">{property.description}</span>}
              {renderInput(key, property, !!schema.required?.includes(key))}
            </FlexComponent>
          ))}
        </form>
      )}
      <FlexComponent color="default" horizontal="center">
        {actions.map(({ action, name, color, font }) => (
          <FlexComponent key={action} border={[1]} color={color} margin={[4]} padding={[4]} rounded={[4]} shrink={1} title={name} style={styles.action} onClick={() => onAction(action)}>
            <IconComponent color={`${color}-fg`} font={font} text={name} />
          </FlexComponent>
        ))}
      </FlexComponent>
    </FlexComponent>
  );
}
