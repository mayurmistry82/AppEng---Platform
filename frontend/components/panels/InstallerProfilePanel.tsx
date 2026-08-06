"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

interface InstallerProfile {
  name: string;
  company: string;
  phone: string;
  email: string;
}

interface InstallerProfilePanelProps {
  userId: string;
}

const EMPTY: InstallerProfile = { name: "", company: "", phone: "", email: "" };

export default function InstallerProfilePanel({
  userId,
}: InstallerProfilePanelProps) {
  const [profile, setProfile] = useState<InstallerProfile>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">(
    "idle",
  );

  // Load profile on mount.
  useEffect(() => {
    if (!userId) return;
    (async () => {
      try {
        const supabase = createClient();
        const { data } = await supabase
          .from("installer_profiles")
          .select("name, company, phone, email")
          .eq("user_id", userId)
          .single();
        if (data) {
          setProfile({
            name: data.name ?? "",
            company: data.company ?? "",
            phone: data.phone ?? "",
            email: data.email ?? "",
          });
        }
      } catch {
        // ignore — profile remains empty
      }
    })();
  }, [userId]);

  // Auto-clear save status after 3 seconds.
  useEffect(() => {
    if (saveStatus === "idle") return;
    const t = setTimeout(() => setSaveStatus("idle"), 3000);
    return () => clearTimeout(t);
  }, [saveStatus]);

  function update<K extends keyof InstallerProfile>(
    key: K,
    value: InstallerProfile[K],
  ) {
    setProfile((p) => ({ ...p, [key]: value }));
  }

  async function handleSave() {
    if (!userId) return;
    setSaving(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.from("installer_profiles").upsert(
        {
          user_id: userId,
          name: profile.name,
          company: profile.company,
          phone: profile.phone,
          email: profile.email,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      );
      if (error) {
        setSaveStatus("error");
      } else {
        setSaveStatus("success");
      }
    } catch {
      setSaveStatus("error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="px-6 pb-4">
        <h2 className="text-sm font-semibold text-foreground">
          Installer Profile
        </h2>
      </div>

      <div className="grid grid-cols-1 gap-10 border-t border-white/[0.06] px-6 py-6 md:grid-cols-3">
        <div className="md:col-span-1">
          <h3 className="text-sm font-semibold text-foreground">
            Your details
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Displayed on all customer reports you generate.
          </p>
        </div>
        <div className="md:col-span-2">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="Name"
              value={profile.name}
              onChange={(v) => update("name", v)}
              autoComplete="name"
            />
            <Field
              label="Company"
              value={profile.company}
              onChange={(v) => update("company", v)}
              autoComplete="organization"
            />
            <Field
              label="Phone"
              value={profile.phone}
              onChange={(v) => update("phone", v)}
              autoComplete="tel"
              type="tel"
            />
            <Field
              label="Email"
              value={profile.email}
              onChange={(v) => update("email", v)}
              autoComplete="email"
              type="email"
            />
          </div>
        </div>
      </div>

      <div className="border-t border-white/[0.06] px-6 py-4">
        <div className="flex items-center justify-end gap-3">
          {saveStatus === "success" && (
            <p className="text-xs text-emerald-400">Profile saved.</p>
          )}
          {saveStatus === "error" && (
            <p className="text-xs text-enrg-amber">
              Could not save profile. Try again.
            </p>
          )}
          {userId ? (
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="rounded-md bg-enrg-gradient px-4 py-2 text-sm font-medium text-enrg-dark transition-all hover:opacity-90 hover:-translate-y-px active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? "Saving..." : "Save Profile"}
            </button>
          ) : (
            <p className="text-xs text-muted-foreground">
              Sign in required to save profile.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  autoComplete,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
  type?: string;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-muted-foreground">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        className="w-full rounded-md border border-white/[0.15] bg-transparent px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/60 transition-colors focus:border-enrg-amber focus:outline-none"
      />
    </div>
  );
}
