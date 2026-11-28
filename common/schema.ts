type IOption = { const: string; title: string };

export type ISchema = {
  type?: string;
  title?: string | null;
  description?: string | null;
  default?: unknown;
  const?: unknown;
  format?: string;
  enum?: string[] | null;
  oneOf?: IOption[] | null;
  anyOf?: IOption[];
  items?: ISchema;
  properties?: { [key: string]: ISchema };
  required?: string[] | null;
  additionalProperties?: ISchema | boolean;
  [k: string]: unknown;
};

export type IFormSchema = ISchema & { properties: { [key: string]: ISchema } };
export type IFormValues = { [key: string]: unknown };
export type IFormAction = { action: string; name: string; color: string; font: string; submit?: boolean };

export interface IFormRequest {
  title: string;
  message?: string;
  url?: string;
  schema?: IFormSchema;
  values?: unknown;
  actions: IFormAction[];
  reply: { event: string; via: "send" | "share"; args?: unknown[] };
}

export const schema = {
  string: (title: string, extra?: ISchema): ISchema => ({ type: "string", title, ...extra }),
  boolean: (title: string, value?: boolean): ISchema => ({ type: "boolean", title, default: value }),
  array: (title: string, items: ISchema, extra?: ISchema): ISchema => ({ type: "array", title, items, ...extra }),
  object: (properties: { [key: string]: ISchema }, required?: string[]): IFormSchema => ({ type: "object", properties, required }),
  record: (title: string, value: ISchema): ISchema => ({ type: "object", title, additionalProperties: value }),
};
