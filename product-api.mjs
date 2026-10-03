// Reviewed public operation tools. Never accepts caller URLs, methods or credentials.
import { z } from 'zod';
import catalog from './product-operations.json' with { type: 'json' };

export const compatibilityAliases = catalog.compatibility_aliases;
export const retiredOperations = catalog.retired_operations;

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number(value.slice(0, 4)) >= 1
    && new Date(`${value}T00:00:00Z`).toISOString?.() === `${value}T00:00:00.000Z`;
}
function calendarDate(value) {
  try { return validDate(value); } catch { return false; }
}
function validCSV(value, rule) {
  const entries = value.split(',');
  if (entries.length > rule.maxItems || new Set(entries).size !== entries.length) return false;
  if (rule.zeroSentinelOnly && entries.includes('0') && entries.length !== 1) return false;
  return entries.every((entry) => {
    if (rule.type === 'event_id') return /^[A-Za-z0-9-]{1,80}$/.test(entry);
    if (!/^(?:0|[1-9][0-9]*)$/.test(entry)) return false;
    const number = Number(entry);
    return Number.isSafeInteger(number) && number >= rule.minimum && number <= rule.maximum
      && !rule.excludedValues?.includes(number);
  });
}

function compile(schema, description) {
  let result;
  switch (schema.type) {
    case 'object': {
      const required = new Set(schema.required ?? []);
      result = z.strictObject(Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, child]) => {
        let field = compile(child, child.description);
        if (!required.has(key)) field = field.optional();
        return [key, field];
      })));
      break;
    }
    case 'array':
      result = z.array(compile(schema.items));
      if (schema.minItems !== undefined) result = result.min(schema.minItems);
      if (schema.maxItems !== undefined) result = result.max(schema.maxItems);
      if (schema.uniqueItems) result = result.refine((values) => new Set(values.map((value) => JSON.stringify(value))).size === values.length, 'Duplicate values are not allowed');
      break;
    case 'integer':
    case 'number':
      result = schema.type === 'integer' ? z.number().int().safe() : z.number();
      if (schema.minimum !== undefined) result = result.min(schema.minimum);
      if (schema.maximum !== undefined) result = result.max(schema.maximum);
      break;
    case 'boolean': result = z.boolean(); break;
    case 'string':
      result = z.string().refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Control characters are not allowed');
      if (schema.minLength !== undefined) result = result.min(schema.minLength);
      if (schema.maxLength !== undefined) result = result.max(schema.maxLength);
      if (schema.pattern) result = result.regex(new RegExp(schema.pattern));
      if (schema.format === 'date') result = result.refine(calendarDate, 'Use a real YYYY-MM-DD date');
      if (schema.format === 'date-time') result = result.refine((value) => /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)
        && calendarDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value)), 'Use an RFC3339 timestamp');
      if (schema.csv) result = result.refine((value) => validCSV(value, schema.csv), 'Use a bounded, unique list of permitted IDs');
      break;
    default: throw new Error('Unsupported reviewed operation schema');
  }
  if (schema.enum) {
    const choices = schema.type === 'string' ? z.enum(schema.enum) : z.union(schema.enum.map((value) => z.literal(value)));
    result = choices.and(result);
  }
  if (schema.excludedValues) result = result.refine((value) => !schema.excludedValues.includes(value), 'Value is excluded');
  const restrictions = [];
  if (schema.csv) restrictions.push(`Comma-separated ${schema.csv.type === 'integer' ? 'integer' : 'event'} IDs; maximum ${schema.csv.maxItems}, unique, no spaces or encoded aliases.${schema.csv.excludedValues?.length ? ' Affiliate 27 is excluded.' : ''}${schema.csv.zeroSentinelOnly ? ' Scores-only 0 must stand alone.' : ''}`);
  if (schema.excludedValues?.length) restrictions.push(`Excluded values: ${schema.excludedValues.join(', ')}.`);
  if (schema.format === 'date' || schema.format === 'date-time') result = result.meta({ format: schema.format });
  const text = [description, ...restrictions].filter(Boolean).join(' ');
  if (text) result = result.describe(text);
  // Validate catalog defaults too; optional callers still receive the public defaults.
  if (schema.default !== undefined) result = result.prefault(schema.default);
  return result;
}

function operationSchema(operation) {
  const fields = {};
  for (const location of ['path', 'query']) {
    const parameters = operation.parameters.filter((parameter) => parameter.in === location);
    if (!parameters.length) continue;
    const shape = Object.fromEntries(parameters.map((parameter) => {
      const schema = compile(parameter.schema, parameter.description);
      return [parameter.name, parameter.required || location === 'path' ? schema : schema.optional()];
    }));
    const nested = z.strictObject(shape);
    fields[location] = location === 'path' || parameters.some((parameter) => parameter.required) ? nested : nested.prefault({});
  }
  if (operation.body) {
    const body = compile(operation.body, 'Read-only same-book price calculation; does not place a wager.');
    fields.body = operation.body_required ? body : body.optional();
  }
  return z.strictObject(fields);
}

const schemas = new Map(catalog.operations.map((operation) => [operation.id, operationSchema(operation)]));
const operations = new Map(catalog.operations.map((operation) => [operation.id, operation]));

// Internal dispatcher helper for the independently registered descriptors below.
export function buildProductRequest(operationId, args) {
  const operation = operations.get(operationId);
  if (!operation) throw new Error('Unknown reviewed public operation');
  const parsed = schemas.get(operationId).parse(args);
  const path = operation.path.replace(/\{([^}]+)\}/g, (_, key) => encodeURIComponent(String(parsed.path[key])));
  if (!/^\/api\/v[12]\//.test(path) || path.includes('{')) throw new Error('Invalid reviewed operation path');
  return { path, query: parsed.query ?? {}, method: operation.method, body: parsed.body };
}

export const operationDescriptors = catalog.operations.map((operation) => Object.freeze({
  id: operation.id,
  name: operation.name,
  title: operation.title,
  description: operation.description,
  inputSchema: schemas.get(operation.id),
  annotations: operation.annotations,
  annotationJustifications: operation.annotation_justifications,
  async execute(args, request, signal) {
    const { path, query, method, body } = buildProductRequest(operation.id, args);
    return request(path, query, signal, { method, body });
  },
}));
