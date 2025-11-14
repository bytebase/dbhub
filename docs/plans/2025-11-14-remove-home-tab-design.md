# Remove Home Tab Design

**Date:** 2025-11-14
**Status:** Approved

## Overview

Remove the Home tab from the frontend navigation since DBHub always has at least one data source configured. The application will default to showing the first data source on initial load.

## Design Decisions

### 1. Routing & Navigation
- Remove the Home route entirely
- Root path `/` redirects to first data source `/source/:firstSourceId`
- Logo always navigates to `/` (which redirects to first source)
- General 404 page for any invalid route

### 2. Sidebar Navigation
- Remove "Home" navigation item
- Sidebar shows only logo and source list
- First source in list serves as default/primary source
- Logo acts as "reset to first source" rather than "go home"

### 3. Error Handling
- Invalid source IDs redirect to general 404 page
- 404 page handles any invalid route (not source-specific)
- Source validation happens in SourceDetailView

### 4. Loading State
- Show loading indicator while sources are being fetched
- Redirect only occurs after sources are loaded
- Prevents flash of error or redirect

## Implementation Changes

### Files to Delete
- `frontend/src/components/views/HomeView.tsx`

### Files to Create
- `frontend/src/components/views/NotFoundView.tsx` - General 404 page

### Files to Modify

**`frontend/src/App.tsx`:**
- Remove HomeView import
- Create RedirectToFirstSource component:
  - Returns null during loading
  - Redirects to `/source/${sources[0].id}` when loaded
- Update routes:
  - Replace index route with RedirectToFirstSource
  - Add catch-all route for 404

**`frontend/src/components/Sidebar/Sidebar.tsx`:**
- Remove "Home" NavItem (if present)
- Ensure logo links to `/`

**`frontend/src/components/views/SourceDetailView.tsx`:**
- Validate sourceId exists in sources list
- Redirect to `/404` if source not found
- Otherwise render detail view normally

## Edge Cases Handled

1. **Invalid source ID in URL** - Redirect to 404 page
2. **Logo click behavior** - Always navigates to `/`, which redirects to first source
3. **Direct URL access to `/`** - Redirect to first source automatically
4. **Loading state** - Show loading indicator, prevent premature redirect
5. **Source ordering** - First source determined by backend (dbhub.toml order)

## Assumptions

- Backend validates at least one data source must be configured
- No special "no sources" state needed in frontend
- Source order from API is stable and determined by backend configuration
