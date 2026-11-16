import { useId, useState } from 'react';
import { Input } from '../ui/input';
import { Checkbox } from '../ui/checkbox';
import type { ToolParameter } from '../../types/datasource';

export type ParameterValues = Record<string, string | number | boolean | string[] | undefined>;

interface ParameterFormProps {
  parameters: ToolParameter[];
  values: ParameterValues;
  onChange: (values: ParameterValues) => void;
}

export function parseParameterValues(parameters: ToolParameter[], values: ParameterValues): ParameterValues {
  return Object.fromEntries(parameters.flatMap(({ name, type, required }) => {
    const value = values[name];
    if (type === 'boolean') {
      if (value === undefined && !required) return [];
      return [[name, value === true || value === 'true']];
    }
    if (value === undefined || value === '') return [];
    if (['integer', 'number', 'float'].includes(type)) return [[name, Number(value)]];
    if (type === 'array') return [[name, String(value).split(',').map(item => item.trim()).filter(Boolean)]];
    return [[name, value]];
  }));
}

export function ParameterForm({ parameters, values, onChange }: ParameterFormProps) {
  return (
    <div className="space-y-5">
      {parameters.map(parameter => (
        <ParameterInput
          key={parameter.name}
          parameter={parameter}
          value={values[parameter.name]}
          onChange={value => onChange({ ...values, [parameter.name]: value })}
        />
      ))}
    </div>
  );
}

function ParameterInput({ parameter, value, onChange }: {
  parameter: ToolParameter;
  value: ParameterValues[string];
  onChange: (value: ParameterValues[string]) => void;
}) {
  const id = useId();
  const [error, setError] = useState('');
  const { name, type, required, description } = parameter;
  const isBoolean = type === 'boolean';
  const isNumeric = ['integer', 'number', 'float'].includes(type);
  const hint = [description, type === 'array' ? 'Separate values with commas.' : ''].filter(Boolean).join(' ');
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;
  const label = (
    <span className="min-w-0 text-label [overflow-wrap:anywhere]">
      <span className="font-mono">{name}</span>
      <span className="ml-2 text-caption font-normal text-muted-foreground">{' '}{required ? 'Required' : 'Optional'}</span>
    </span>
  );

  return (
    <div className="space-y-1.5">
      {isBoolean ? (
        <label htmlFor={id} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md">
          <Checkbox id={id} name={name} checked={value === true || value === 'true'} onCheckedChange={onChange} aria-describedby={describedBy} />
          {label}
        </label>
      ) : (
        <>
          <label htmlFor={id} className="block">{label}</label>
          <Input
            id={id}
            name={name}
            type={isNumeric ? 'number' : 'text'}
            step="any"
            inputMode={isNumeric ? (type === 'integer' ? 'numeric' : 'decimal') : undefined}
            required={required}
            value={Array.isArray(value) ? value.join(', ') : typeof value === 'boolean' ? String(value) : value ?? ''}
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore
            aria-describedby={describedBy}
            aria-invalid={error ? true : undefined}
            className="[&_input]:min-h-11 sm:text-base"
            onChange={event => {
              const message = validateParameterInput(event.currentTarget, parameter);
              if (error) setError(message);
              onChange(event.currentTarget.value);
            }}
            onBlur={event => setError(validateParameterInput(event.currentTarget, parameter))}
            onInvalid={event => {
              event.preventDefault();
              setError(validateParameterInput(event.currentTarget, parameter));
            }}
          />
        </>
      )}
      {hint && <p id={`${id}-hint`} className="text-caption text-muted-foreground max-w-prose text-pretty [overflow-wrap:anywhere]">{hint}</p>}
      {error && <p id={`${id}-error`} className="text-caption text-destructive-foreground" role="alert">{error}</p>}
    </div>
  );
}

export function validateParameterInput(input: HTMLInputElement, { type, required }: ToolParameter) {
  input.setCustomValidity('');
  if (required && type === 'array' && !input.value.split(',').some(item => item.trim())) {
    input.setCustomValidity('Enter at least one value.');
  }
  if (type === 'integer' && input.value !== '' && !Number.isInteger(Number(input.value))) {
    input.setCustomValidity('Enter a whole number.');
  }
  if (input.validity.badInput) return 'Enter a number.';
  if (input.validity.valueMissing) return 'Enter a value.';
  return input.validationMessage;
}
