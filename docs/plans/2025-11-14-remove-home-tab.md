# Remove Home Tab Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the Home tab from frontend navigation and default to showing the first data source on initial load.

**Architecture:** Replace the index route with a redirect component that navigates to the first source. Add a general 404 page for invalid routes. Remove Home navigation from sidebar.

**Tech Stack:** React, React Router, TypeScript

---

## Task 1: Create NotFoundView Component

**Files:**
- Create: `frontend/src/components/views/NotFoundView.tsx`

**Step 1: Create the NotFoundView component**

Create `frontend/src/components/views/NotFoundView.tsx`:

```tsx
import { Link } from 'react-router-dom';

export default function NotFoundView() {
  return (
    <div className="container mx-auto px-8 py-12 max-w-4xl">
      <div className="space-y-6">
        <div>
          <h1 className="text-4xl font-bold text-foreground mb-4">
            404 - Page Not Found
          </h1>
          <p className="text-xl text-muted-foreground">
            The page you're looking for doesn't exist.
          </p>
        </div>

        <div className="bg-muted rounded-lg p-6">
          <p className="text-muted-foreground mb-4">
            The URL you entered could not be found. This might be because:
          </p>
          <ul className="space-y-2 text-muted-foreground list-disc list-inside">
            <li>The page was moved or deleted</li>
            <li>You typed the URL incorrectly</li>
            <li>The resource ID is invalid</li>
          </ul>
        </div>

        <div>
          <Link
            to="/"
            className="inline-flex items-center px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
          >
            Go to Home
          </Link>
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add frontend/src/components/views/NotFoundView.tsx
git commit -m "feat: add general 404 not found page"
```

---

## Task 2: Update App.tsx with Redirect Logic and 404 Route

**Files:**
- Modify: `frontend/src/App.tsx`

**Step 1: Add RedirectToFirstSource component and update routes**

In `frontend/src/App.tsx`, make these changes:

1. Remove the HomeView import (line 4):
```tsx
// DELETE THIS LINE:
import HomeView from './components/views/HomeView';
```

2. Add NotFoundView import:
```tsx
// ADD after other view imports:
import NotFoundView from './components/views/NotFoundView';
```

3. Add Navigate import from react-router-dom (modify line 2):
```tsx
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
```

4. Add RedirectToFirstSource component before the App component (after imports):
```tsx
function RedirectToFirstSource({ sources, isLoading }: { sources: DataSource[]; isLoading: boolean }) {
  if (isLoading) {
    return (
      <div className="container mx-auto px-8 py-12">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (sources.length === 0) {
    // This should never happen as backend validates at least one source
    return (
      <div className="container mx-auto px-8 py-12">
        <div className="text-destructive">No data sources configured</div>
      </div>
    );
  }

  return <Navigate to={`/source/${sources[0].id}`} replace />;
}
```

5. Update the routes (replace line 32):
```tsx
// REPLACE:
<Route index element={<HomeView />} />

// WITH:
<Route index element={<RedirectToFirstSource sources={sources} isLoading={isLoading} />} />
```

6. Add catch-all 404 route (after the source/:sourceId route, before closing </Route>):
```tsx
<Route path="*" element={<NotFoundView />} />
```

The complete Routes section should now look like:
```tsx
<Routes>
  <Route path="/" element={<Layout sources={sources} isLoading={isLoading} />}>
    <Route index element={<RedirectToFirstSource sources={sources} isLoading={isLoading} />} />
    <Route path="source/:sourceId" element={<SourceDetailView />} />
    <Route path="*" element={<NotFoundView />} />
  </Route>
</Routes>
```

**Step 2: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat: redirect root to first source and add 404 route"
```

---

## Task 3: Update SourceDetailView to Redirect Invalid Sources to 404

**Files:**
- Modify: `frontend/src/components/views/SourceDetailView.tsx`

**Step 1: Add sources prop and validation logic**

The SourceDetailView currently fetches individual source data. When the fetch fails with 404, we should redirect to the general 404 page.

Modify the error handling in `frontend/src/components/views/SourceDetailView.tsx`:

1. Update the error state handling (around line 49-58). Replace the error rendering block:

```tsx
// REPLACE THIS BLOCK:
if (error) {
  return (
    <div className="container mx-auto px-8 py-12">
      <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-6">
        <h2 className="text-lg font-semibold text-destructive mb-2">Error</h2>
        <p className="text-destructive/90">{error}</p>
      </div>
    </div>
  );
}

// WITH THIS:
if (error) {
  // If source not found, redirect to 404 page
  if (error.includes('not found') || error.includes('404')) {
    return <Navigate to="/404" replace />;
  }

  // For other errors, show error message
  return (
    <div className="container mx-auto px-8 py-12">
      <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-6">
        <h2 className="text-lg font-semibold text-destructive mb-2">Error</h2>
        <p className="text-destructive/90">{error}</p>
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add frontend/src/components/views/SourceDetailView.tsx
git commit -m "feat: redirect invalid source IDs to 404 page"
```

---

## Task 4: Remove Home Navigation from Sidebar

**Files:**
- Modify: `frontend/src/components/Sidebar/Sidebar.tsx`

**Step 1: Remove HomeIcon and Home NavItem**

In `frontend/src/components/Sidebar/Sidebar.tsx`:

1. Remove the NavItem import (line 2) since it's only used for Home:
```tsx
// REMOVE THIS LINE:
import NavItem from './NavItem';
```

2. Remove the entire HomeIcon component (lines 11-28):
```tsx
// DELETE THIS ENTIRE FUNCTION:
function HomeIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  );
}
```

3. Remove the Home NavItem from the nav section (line 35):
```tsx
// DELETE THIS LINE:
<NavItem to="/" icon={<HomeIcon />} label="Home" />
```

The sidebar's nav section should now only contain:
```tsx
<nav className="flex-1 flex flex-col overflow-hidden" aria-label="Sidebar navigation">
  <SourceList sources={sources} isLoading={isLoading} />
</nav>
```

**Step 2: Commit**

```bash
git add frontend/src/components/Sidebar/Sidebar.tsx
git commit -m "feat: remove Home navigation item from sidebar"
```

---

## Task 5: Delete HomeView Component

**Files:**
- Delete: `frontend/src/components/views/HomeView.tsx`

**Step 1: Delete the HomeView file**

```bash
rm frontend/src/components/views/HomeView.tsx
```

**Step 2: Commit**

```bash
git add frontend/src/components/views/HomeView.tsx
git commit -m "feat: remove unused HomeView component"
```

---

## Task 6: Manual Testing

**Step 1: Start the development server**

```bash
cd frontend
pnpm dev
```

**Step 2: Test initial load**

1. Navigate to `http://localhost:5173/`
2. Verify: Automatically redirects to `/source/:firstSourceId`
3. Verify: First source details are displayed

**Step 3: Test logo navigation**

1. Click on a different source in the sidebar
2. Click the logo
3. Verify: Redirects back to first source

**Step 4: Test invalid source ID**

1. Navigate to `http://localhost:5173/source/invalid-id`
2. Verify: Shows 404 page with "Page Not Found" message
3. Verify: "Go to Home" link redirects to first source

**Step 5: Test invalid route**

1. Navigate to `http://localhost:5173/random/invalid/path`
2. Verify: Shows 404 page
3. Verify: "Go to Home" link works

**Step 6: Test sidebar**

1. Verify: No "Home" navigation item in sidebar
2. Verify: Source list appears immediately below logo
3. Verify: Can navigate between sources

**Expected Results:**
- ✅ Root path redirects to first source
- ✅ Logo click navigates to first source
- ✅ Invalid source IDs show 404 page
- ✅ Invalid routes show 404 page
- ✅ No Home navigation item visible
- ✅ All source navigation works correctly

---

## Completion Checklist

- [ ] NotFoundView component created
- [ ] App.tsx updated with redirect logic and 404 route
- [ ] SourceDetailView redirects invalid sources to 404
- [ ] Sidebar Home navigation removed
- [ ] HomeView component deleted
- [ ] All manual tests pass
- [ ] All changes committed

---

## Notes

- This plan assumes backend validates at least one data source exists
- The first source in the array is the default (backend determines order)
- 404 page is general-purpose for any invalid route
- Logo navigation always goes to `/` which redirects to first source
