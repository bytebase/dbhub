# Gutter Bar Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a narrow icon-only gutter bar on the far left with Home and Help navigation icons.

**Architecture:** Three-column flex layout: Gutter (48px) → Sidebar (200-280px) → Main Content. GutterIcon component handles both internal navigation (Link) and external links (anchor) with Radix tooltips.

**Tech Stack:** React, React Router, Radix UI Tooltip, Tailwind CSS

---

## Overview

Add a narrow icon-only gutter bar on the far left of the application, containing Home and Help navigation icons. The existing sidebar remains for data source navigation.

## Layout Structure

```
┌─────────┬──────────────────┬────────────────────────────┐
│ GUTTER  │     SIDEBAR      │         MAIN CONTENT       │
│  48px   │    200-280px     │           flex-1           │
│         │                  │                            │
│  [Home] │  Logo            │                            │
│         │  ─────────────   │                            │
│         │  Data Sources    │                            │
│         │  • prod_pg       │                            │
│         │  • staging_mysql │                            │
│         │                  │                            │
│         │                  │                            │
│  [Help] │                  │                            │
└─────────┴──────────────────┴────────────────────────────┘
```

## Gutter Specifications

- **Width:** Fixed 48px
- **Height:** Full viewport height
- **Background:** Same as sidebar (`bg-background`)
- **Border:** Right border using design tokens (`border-r border-border`)

### Icon Placement

- **Home icon:** Top of gutter, with top padding
- **Help icon:** Pinned to bottom of gutter

### Icon Behavior

- **Home:** Navigates to `/` (home view)
- **Help:** Opens external documentation (https://dbhub.ai)

## Component Design

### GutterIcon Component

- **Size:** 40px × 40px clickable area, centered in 48px gutter
- **Border radius:** `rounded-lg`
- **Hover state:** `bg-accent`
- **Active state:** `bg-accent text-accent-foreground` with left accent bar
- **Tooltip:** Shows on hover using Radix tooltip (existing dependency)

### Gutter Component Structure

```tsx
<aside className="w-12 h-screen flex flex-col border-r border-border bg-background">
  {/* Top section */}
  <div className="flex-1 pt-3">
    <GutterIcon icon={<HomeIcon />} to="/" tooltip="Home" />
  </div>

  {/* Bottom section - pinned */}
  <div className="pb-3">
    <GutterIcon icon={<HelpIcon />} href="https://dbhub.ai" tooltip="Help" external />
  </div>
</aside>
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/components/Gutter/Gutter.tsx` | Create | Main gutter component |
| `src/components/Gutter/GutterIcon.tsx` | Create | Reusable icon button with tooltip |
| `src/components/Gutter/index.ts` | Create | Component exports |
| `src/components/Layout.tsx` | Update | Add Gutter to layout flex container |
| `src/components/Sidebar/Sidebar.tsx` | Update | Remove Home and Help links |

## Sidebar Modifications

After adding the gutter, the sidebar will:
- **Keep:** Logo section, Data Sources header, source list with database icons
- **Remove:** Home navigation link, Help link at bottom

The Logo remains in the sidebar to provide branding context adjacent to the gutter icons.

---

## Implementation Tasks

### Task 1: Create GutterIcon Component

**Files:**
- Create: `frontend/src/components/Gutter/GutterIcon.tsx`

**Step 1: Create the Gutter directory**

```bash
mkdir -p frontend/src/components/Gutter
```

**Step 2: Create GutterIcon component**

Create `frontend/src/components/Gutter/GutterIcon.tsx`:

```tsx
import { Link, useLocation } from 'react-router-dom';
import * as Tooltip from '@radix-ui/react-tooltip';
import { cn } from '../../lib/utils';

interface GutterIconProps {
  icon: React.ReactNode;
  tooltip: string;
  to?: string;
  href?: string;
}

export default function GutterIcon({ icon, tooltip, to, href }: GutterIconProps) {
  const location = useLocation();
  const isActive = to ? location.pathname === to : false;

  const iconButton = (
    <div
      className={cn(
        'w-10 h-10 flex items-center justify-center rounded-lg transition-colors cursor-pointer',
        'hover:bg-accent hover:text-accent-foreground',
        isActive && 'bg-accent text-accent-foreground'
      )}
    >
      {icon}
    </div>
  );

  const wrappedIcon = to ? (
    <Link to={to} aria-label={tooltip}>
      {iconButton}
    </Link>
  ) : href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" aria-label={tooltip}>
      {iconButton}
    </a>
  ) : (
    iconButton
  );

  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        {wrappedIcon}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="right"
          sideOffset={8}
          className="z-50 px-2 py-1 text-xs bg-popover text-popover-foreground rounded shadow-md"
        >
          {tooltip}
          <Tooltip.Arrow className="fill-popover" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
```

**Step 3: Verify file was created**

```bash
cat frontend/src/components/Gutter/GutterIcon.tsx
```

**Step 4: Commit**

```bash
git add frontend/src/components/Gutter/GutterIcon.tsx
git commit -m "feat(ui): add GutterIcon component with tooltip support"
```

---

### Task 2: Create Gutter Component

**Files:**
- Create: `frontend/src/components/Gutter/Gutter.tsx`
- Create: `frontend/src/components/Gutter/index.ts`

**Step 1: Create Gutter component**

Create `frontend/src/components/Gutter/Gutter.tsx`:

```tsx
import * as Tooltip from '@radix-ui/react-tooltip';
import GutterIcon from './GutterIcon';
import HomeIcon from '../icons/HomeIcon';
import HelpIcon from '../icons/HelpIcon';

export default function Gutter() {
  return (
    <Tooltip.Provider delayDuration={300}>
      <aside
        className="w-12 h-screen flex flex-col items-center border-r border-border bg-background"
        aria-label="Main navigation"
      >
        <div className="flex-1 pt-3">
          <GutterIcon icon={<HomeIcon />} to="/" tooltip="Home" />
        </div>
        <div className="pb-3">
          <GutterIcon icon={<HelpIcon />} href="https://dbhub.ai" tooltip="Help" />
        </div>
      </aside>
    </Tooltip.Provider>
  );
}
```

**Step 2: Create index.ts export**

Create `frontend/src/components/Gutter/index.ts`:

```ts
export { default } from './Gutter';
```

**Step 3: Verify files were created**

```bash
ls frontend/src/components/Gutter/
```

Expected: `Gutter.tsx  GutterIcon.tsx  index.ts`

**Step 4: Commit**

```bash
git add frontend/src/components/Gutter/
git commit -m "feat(ui): add Gutter component with Home and Help icons"
```

---

### Task 3: Update Layout to Include Gutter

**Files:**
- Modify: `frontend/src/components/Layout.tsx`

**Step 1: Update Layout.tsx**

Replace the entire file with:

```tsx
import { Outlet } from 'react-router-dom';
import Gutter from './Gutter';
import Sidebar from './Sidebar/Sidebar';
import type { DataSource } from '../types/datasource';

interface LayoutProps {
  sources: DataSource[];
  isLoading: boolean;
}

export default function Layout({ sources, isLoading }: LayoutProps) {
  return (
    <div className="flex h-screen bg-background">
      <Gutter />
      <Sidebar sources={sources} isLoading={isLoading} />
      <main className="flex-1 overflow-auto" aria-label="Main content">
        <Outlet />
      </main>
    </div>
  );
}
```

**Step 2: Verify the change**

```bash
cat frontend/src/components/Layout.tsx
```

**Step 3: Commit**

```bash
git add frontend/src/components/Layout.tsx
git commit -m "feat(ui): integrate Gutter into Layout"
```

---

### Task 4: Remove Home and Help from Sidebar

**Files:**
- Modify: `frontend/src/components/Sidebar/Sidebar.tsx`

**Step 1: Update Sidebar.tsx**

Replace the entire file with:

```tsx
import Logo from './Logo';
import SourceList from './SourceList';
import type { DataSource } from '../../types/datasource';

interface SidebarProps {
  sources: DataSource[];
  isLoading: boolean;
}

export default function Sidebar({ sources, isLoading }: SidebarProps) {
  return (
    <aside
      className="w-[200px] sm:w-[220px] md:w-[240px] lg:w-[280px] border-r border-border bg-card flex flex-col"
      aria-label="Data sources sidebar"
    >
      <Logo />
      <nav className="flex-1 flex flex-col overflow-hidden" aria-label="Data sources navigation">
        <SourceList sources={sources} isLoading={isLoading} />
      </nav>
    </aside>
  );
}
```

**Step 2: Verify the change**

```bash
cat frontend/src/components/Sidebar/Sidebar.tsx
```

**Step 3: Commit**

```bash
git add frontend/src/components/Sidebar/Sidebar.tsx
git commit -m "refactor(ui): remove Home and Help links from Sidebar"
```

---

### Task 5: Visual Verification

**Step 1: Start dev server**

```bash
cd frontend && pnpm dev
```

**Step 2: Visual checks**

Open http://localhost:5173 and verify:
- [ ] Gutter bar appears on far left (48px wide)
- [ ] Home icon at top of gutter
- [ ] Help icon at bottom of gutter
- [ ] Hovering icons shows tooltip
- [ ] Clicking Home navigates to `/`
- [ ] Clicking Help opens https://dbhub.ai in new tab
- [ ] Home icon shows active state when on home page
- [ ] Sidebar still shows Logo and Data Sources
- [ ] No Home/Help links in sidebar

**Step 3: Stop dev server and commit verification**

```bash
git add -A
git commit -m "chore: gutter bar implementation complete"
```
