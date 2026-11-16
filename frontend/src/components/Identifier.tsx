import { Fragment } from 'react';

export default function Identifier({ children }: { children: string }) {
  return children.split(/([_.-])/).map((part, index) => (
    <Fragment key={index}>
      {part}{/^[_.-]$/.test(part) && <wbr />}
    </Fragment>
  ));
}
