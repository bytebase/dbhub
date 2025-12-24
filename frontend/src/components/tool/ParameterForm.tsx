import { Input } from '../ui/input';
import { Checkbox } from '../ui/checkbox';
import type { ToolParameter } from '../../types/datasource';
import { useEffect, useState } from 'react';

interface ParameterFormProps {
  parameters: ToolParameter[];
  values: Record<string, any>;
  onChange: (values: Record<string, any>) => void;
}

export function ParameterForm({ parameters, values, onChange }: ParameterFormProps) {
  const handleChange = (name: string, value: any) => {
    onChange({ ...values, [name]: value });
  };

  return (
    <div className="space-y-4">
      {parameters.map((param) => (
        <div key={param.name} className="space-y-1.5">
          <label className="text-sm font-medium text-foreground">
            {param.name}
            {param.required ? (
              <span className="text-destructive ml-0.5">*</span>
            ) : (
              <span className="text-muted-foreground ml-1.5 font-normal">(optional)</span>
            )}
          </label>
          <ParameterInput
            parameter={param}
            value={values[param.name]}
            onChange={(value) => handleChange(param.name, value)}
          />
          {param.description && (
            <p className="text-xs text-muted-foreground">{param.description}</p>
          )}
        </div>
      ))}
    </div>
  );
}

interface ParameterInputProps {
  parameter: ToolParameter;
  value: any;
  onChange: (value: any) => void;
}

function ParameterInput({ parameter, value, onChange }: ParameterInputProps) {
  const { type, name } = parameter;

  // Boolean type: checkbox
  if (type === 'boolean') {
    const [localChecked, setLocalChecked] = useState<boolean>(value === true || value === 'true');

    // Sync local state when value prop changes
    useEffect(() => {
      const newChecked = value === true || value === 'true';
      setLocalChecked(newChecked);
    }, [value]);

    return (
      <div className="flex items-center h-10">
        <Checkbox
          checked={localChecked}
          onCheckedChange={(checked) => {
            setLocalChecked(checked);
            onChange(checked);
          }}
        />
      </div>
    );
  }

  // Integer type: number input with step=1
  if (type === 'integer') {
    return (
      <Input
        type="number"
        step={1}
        value={value ?? ''}
        onChange={(e) => {
          const val = e.target.value;
          onChange(val === '' ? undefined : parseInt(val, 10));
        }}
        placeholder={`Enter ${name}`}
      />
    );
  }

  // Float type: number input with step=any
  if (type === 'float' || type === 'number') {
    return (
      <Input
        type="number"
        step="any"
        value={value ?? ''}
        onChange={(e) => {
          const val = e.target.value;
          onChange(val === '' ? undefined : parseFloat(val));
        }}
        placeholder={`Enter ${name}`}
      />
    );
  }

  // Array type: comma-separated text input
  if (type === 'array') {
    return (
      <Input
        type="text"
        value={Array.isArray(value) ? value.join(', ') : ''}
        onChange={(e) => {
          const val = e.target.value;
          onChange(val ? val.split(',').map((s) => s.trim()) : undefined);
        }}
        placeholder="Enter comma-separated values"
      />
    );
  }

  // Default: string text input
  return (
    <Input
      type="text"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || undefined)}
      placeholder={`Enter ${name}`}
    />
  );
}
