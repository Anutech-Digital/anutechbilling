"use client";

import * as React from "react";
import { SYSTEM_MODULES, DEFAULT_ACTIVE_MODULE_IDS, type SystemModule } from "./registry";

const STORAGE_KEY = "reselleros_active_modules_v1";
export const MODULES_CHANGED_EVENT = "reselleros:modules-changed";

export function useModules() {
  const [activeModuleIds, setActiveModuleIds] = React.useState<string[]>(DEFAULT_ACTIVE_MODULE_IDS);
  const [isLoaded, setIsLoaded] = React.useState(false);

  // Load from localStorage on mount & listen for real-time cross-component updates
  React.useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          setActiveModuleIds(parsed);
        }
      }
    } catch {
      // Fallback to defaults
    } finally {
      setIsLoaded(true);
    }

    const handleModulesChanged = (e: Event) => {
      const customEvent = e as CustomEvent<string[]>;
      if (customEvent.detail && Array.isArray(customEvent.detail)) {
        setActiveModuleIds(customEvent.detail);
      }
    };

    const handleStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && e.newValue) {
        try {
          const parsed = JSON.parse(e.newValue);
          if (Array.isArray(parsed)) {
            setActiveModuleIds(parsed);
          }
        } catch {}
      }
    };

    if (typeof window !== "undefined") {
      window.addEventListener(MODULES_CHANGED_EVENT, handleModulesChanged);
      window.addEventListener("storage", handleStorage);
    }

    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener(MODULES_CHANGED_EVENT, handleModulesChanged);
        window.removeEventListener("storage", handleStorage);
      }
    };
  }, []);

  const saveModules = React.useCallback((ids: string[]) => {
    setActiveModuleIds(ids);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(MODULES_CHANGED_EVENT, { detail: ids }));
      }
    } catch {
      // Ignore storage errors
    }
  }, []);

  const isModuleActive = React.useCallback(
    (moduleId: string) => {
      return activeModuleIds.includes(moduleId);
    },
    [activeModuleIds],
  );

  const toggleModule = React.useCallback(
    (moduleId: string) => {
      const next = activeModuleIds.includes(moduleId)
        ? activeModuleIds.filter((id) => id !== moduleId)
        : [...activeModuleIds, moduleId];
      saveModules(next);
    },
    [activeModuleIds, saveModules],
  );

  const activateAll = React.useCallback(() => {
    saveModules(DEFAULT_ACTIVE_MODULE_IDS);
  }, [saveModules]);

  const paidModules = React.useMemo(
    () => SYSTEM_MODULES.filter((m) => m.priceMonthlyRupees > 0),
    [],
  );

  const allPaidModulesActive = React.useMemo(() => {
    return paidModules.every((m) => activeModuleIds.includes(m.id));
  }, [paidModules, activeModuleIds]);

  const totalMonthlyCostRupees = React.useMemo(() => {
    // If all commercial paid modules are active, bundle cap is ₹1999
    if (allPaidModulesActive) {
      return 1999;
    }
    return SYSTEM_MODULES.filter((m) => activeModuleIds.includes(m.id)).reduce(
      (sum, m) => sum + m.priceMonthlyRupees,
      0,
    );
  }, [allPaidModulesActive, activeModuleIds]);

  const bundleSavingsRupees = React.useMemo(() => {
    // If all 5 commercial paid modules are taken, full bundle is ₹1999 (regular sum is 499+499+399+999+499 = ₹2895)
    if (allPaidModulesActive) {
      return 2895 - 1999; // ₹896 discount
    }
    return 0;
  }, [allPaidModulesActive]);

  const isFreePlanOnly = React.useMemo(() => {
    return (
      totalMonthlyCostRupees === 0 &&
      (activeModuleIds.includes("solo_free") || activeModuleIds.includes("salaried_pro"))
    );
  }, [totalMonthlyCostRupees, activeModuleIds]);

  return {
    modules: SYSTEM_MODULES,
    activeModuleIds,
    isLoaded,
    isModuleActive,
    toggleModule,
    activateAll,
    totalMonthlyCostRupees,
    bundleSavingsRupees,
    isFreePlanOnly,
    activeCount: activeModuleIds.length,
    totalCount: SYSTEM_MODULES.length,
  };
}
