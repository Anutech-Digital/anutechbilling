-- ============================================================================
-- Migration: 20261112103000_modular_plugin_licensing.sql
-- Purpose: Pluggable Modular Architecture Schema (DPDP compliant)
-- Allows ResellerOS to sell CRM, Invoicing, Subscriptions, Provisioning,
-- and TeamOps as individual plug-ins on top of the shared core database.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.tenant_modules (
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  module_id TEXT NOT NULL CHECK (module_id IN ('crm', 'invoicing', 'subscriptions', 'provisioning', 'teamops')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'trial', 'cancelled', 'past_due')),
  plan_tier TEXT NOT NULL DEFAULT 'standard',
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, module_id)
);

-- Index for instant lookup by status
CREATE INDEX IF NOT EXISTS idx_tenant_modules_lookup 
  ON public.tenant_modules(tenant_id, module_id, status);

-- Enable Row-Level Security
ALTER TABLE public.tenant_modules ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Tenants can view only their own subscribed modules
CREATE POLICY tenant_modules_tenant_select ON public.tenant_modules
  FOR SELECT
  USING (tenant_id = public.current_tenant_id());

-- RLS Policy: Tenant owner or platform admin can manage installed modules
CREATE POLICY tenant_modules_tenant_manage ON public.tenant_modules
  FOR ALL
  USING (
    tenant_id = public.current_tenant_id()
    AND (
      EXISTS (
        SELECT 1 FROM public.users
        WHERE id = auth.uid() AND tenant_id = public.current_tenant_id() AND role = 'owner'
      )
      OR public.is_platform_admin()
    )
  );

-- Helper function: Check if current tenant has an active module
CREATE OR REPLACE FUNCTION public.has_tenant_module(p_module_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.tenant_modules
    WHERE tenant_id = public.current_tenant_id()
      AND module_id = p_module_id
      AND status IN ('active', 'trial')
      AND (expires_at IS NULL OR expires_at > now())
  );
$$;

-- Helper function: List all active modules for current tenant
CREATE OR REPLACE FUNCTION public.list_tenant_modules()
RETURNS TABLE (
  module_id TEXT,
  status TEXT,
  plan_tier TEXT,
  expires_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT module_id, status, plan_tier, expires_at
  FROM public.tenant_modules
  WHERE tenant_id = public.current_tenant_id()
    AND status IN ('active', 'trial')
    AND (expires_at IS NULL OR expires_at > now());
$$;

-- Safe Backfill: Ensure all existing tenants have all 5 modules active so nothing breaks
INSERT INTO public.tenant_modules (tenant_id, module_id, status, plan_tier)
SELECT t.id, m.id, 'active', 'full_suite'
FROM public.tenants t
CROSS JOIN (
  VALUES 
    ('crm'),
    ('invoicing'),
    ('subscriptions'),
    ('provisioning'),
    ('teamops')
) AS m(id)
ON CONFLICT (tenant_id, module_id) DO NOTHING;
