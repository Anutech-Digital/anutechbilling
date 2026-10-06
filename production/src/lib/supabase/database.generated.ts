export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      academy_apprentice_skills: {
        Row: {
          apprentice_id: string
          mentor_note: string | null
          percent: number
          skill_id: string
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          apprentice_id: string
          mentor_note?: string | null
          percent?: number
          skill_id: string
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          apprentice_id?: string
          mentor_note?: string | null
          percent?: number
          skill_id?: string
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "academy_apprentice_skills_apprentice_id_fkey"
            columns: ["apprentice_id"]
            isOneToOne: false
            referencedRelation: "academy_apprentices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_apprentice_skills_skill_id_fkey"
            columns: ["skill_id"]
            isOneToOne: false
            referencedRelation: "academy_skills"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_apprentice_skills_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_apprentice_skills_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_apprentice_skills_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      academy_apprentices: {
        Row: {
          address: string | null
          code: string
          course: string | null
          created_at: string
          date_of_birth: string | null
          email: string | null
          emergency_contact_name: string | null
          emergency_contact_phone: string | null
          end_date: string | null
          full_name: string
          id: string
          institute: string | null
          joining_date: string | null
          mentor_user_id: string | null
          notes: string | null
          phone: string | null
          program_id: string | null
          qualification: string | null
          start_date: string | null
          status: string
          tenant_id: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          address?: string | null
          code?: string
          course?: string | null
          created_at?: string
          date_of_birth?: string | null
          email?: string | null
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          end_date?: string | null
          full_name: string
          id?: string
          institute?: string | null
          joining_date?: string | null
          mentor_user_id?: string | null
          notes?: string | null
          phone?: string | null
          program_id?: string | null
          qualification?: string | null
          start_date?: string | null
          status?: string
          tenant_id: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          address?: string | null
          code?: string
          course?: string | null
          created_at?: string
          date_of_birth?: string | null
          email?: string | null
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          end_date?: string | null
          full_name?: string
          id?: string
          institute?: string | null
          joining_date?: string | null
          mentor_user_id?: string | null
          notes?: string | null
          phone?: string | null
          program_id?: string | null
          qualification?: string | null
          start_date?: string | null
          status?: string
          tenant_id?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "academy_apprentices_mentor_user_id_fkey"
            columns: ["mentor_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_apprentices_program_id_fkey"
            columns: ["program_id"]
            isOneToOne: false
            referencedRelation: "academy_programs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_apprentices_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_apprentices_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      academy_evaluations: {
        Row: {
          ai_tool_usage: number
          apprentice_id: string
          code_quality: number
          communication: number
          created_at: string
          evaluated_by: string | null
          id: string
          improve: string | null
          next_focus: string | null
          problem_solving: number
          strengths: string | null
          task_completion: number
          technical: number
          tenant_id: string
          total: number | null
          updated_at: string
          week_start: string
        }
        Insert: {
          ai_tool_usage: number
          apprentice_id: string
          code_quality: number
          communication: number
          created_at?: string
          evaluated_by?: string | null
          id?: string
          improve?: string | null
          next_focus?: string | null
          problem_solving: number
          strengths?: string | null
          task_completion: number
          technical: number
          tenant_id: string
          total?: number | null
          updated_at?: string
          week_start: string
        }
        Update: {
          ai_tool_usage?: number
          apprentice_id?: string
          code_quality?: number
          communication?: number
          created_at?: string
          evaluated_by?: string | null
          id?: string
          improve?: string | null
          next_focus?: string | null
          problem_solving?: number
          strengths?: string | null
          task_completion?: number
          technical?: number
          tenant_id?: string
          total?: number | null
          updated_at?: string
          week_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "academy_evaluations_apprentice_id_fkey"
            columns: ["apprentice_id"]
            isOneToOne: false
            referencedRelation: "academy_apprentices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_evaluations_evaluated_by_fkey"
            columns: ["evaluated_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_evaluations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_evaluations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      academy_modules: {
        Row: {
          created_at: string
          id: string
          position: number
          program_id: string
          tenant_id: string
          title: string
          topics: string[]
        }
        Insert: {
          created_at?: string
          id?: string
          position?: number
          program_id: string
          tenant_id: string
          title: string
          topics?: string[]
        }
        Update: {
          created_at?: string
          id?: string
          position?: number
          program_id?: string
          tenant_id?: string
          title?: string
          topics?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "academy_modules_program_id_fkey"
            columns: ["program_id"]
            isOneToOne: false
            referencedRelation: "academy_programs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_modules_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_modules_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      academy_programs: {
        Row: {
          created_at: string
          description: string | null
          id: string
          is_default: boolean
          name: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          is_default?: boolean
          name: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          is_default?: boolean
          name?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "academy_programs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_programs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      academy_skills: {
        Row: {
          created_at: string
          id: string
          name: string
          position: number
          tenant_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          position?: number
          tenant_id: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          position?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "academy_skills_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_skills_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      academy_submissions: {
        Row: {
          apprentice_id: string
          attempt: number
          feedback: string | null
          github_url: string | null
          id: string
          link_url: string | null
          marks: number | null
          note: string | null
          review_result: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          submitted_at: string
          task_id: string
          tenant_id: string
        }
        Insert: {
          apprentice_id: string
          attempt?: number
          feedback?: string | null
          github_url?: string | null
          id?: string
          link_url?: string | null
          marks?: number | null
          note?: string | null
          review_result?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          submitted_at?: string
          task_id: string
          tenant_id: string
        }
        Update: {
          apprentice_id?: string
          attempt?: number
          feedback?: string | null
          github_url?: string | null
          id?: string
          link_url?: string | null
          marks?: number | null
          note?: string | null
          review_result?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          submitted_at?: string
          task_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "academy_submissions_apprentice_id_fkey"
            columns: ["apprentice_id"]
            isOneToOne: false
            referencedRelation: "academy_apprentices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_submissions_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_submissions_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "academy_tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_submissions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_submissions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      academy_tasks: {
        Row: {
          apprentice_id: string
          completed_at: string | null
          created_at: string
          created_by: string | null
          description: string | null
          difficulty: string
          due_date: string | null
          est_minutes: number | null
          id: string
          instructions: string | null
          kind: string
          module_id: string | null
          priority: string
          reference_url: string | null
          status: string
          submission_type: string
          tenant_id: string
          title: string
          updated_at: string
        }
        Insert: {
          apprentice_id: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          difficulty?: string
          due_date?: string | null
          est_minutes?: number | null
          id?: string
          instructions?: string | null
          kind?: string
          module_id?: string | null
          priority?: string
          reference_url?: string | null
          status?: string
          submission_type?: string
          tenant_id: string
          title: string
          updated_at?: string
        }
        Update: {
          apprentice_id?: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          difficulty?: string
          due_date?: string | null
          est_minutes?: number | null
          id?: string
          instructions?: string | null
          kind?: string
          module_id?: string | null
          priority?: string
          reference_url?: string | null
          status?: string
          submission_type?: string
          tenant_id?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "academy_tasks_apprentice_id_fkey"
            columns: ["apprentice_id"]
            isOneToOne: false
            referencedRelation: "academy_apprentices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_tasks_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_tasks_module_id_fkey"
            columns: ["module_id"]
            isOneToOne: false
            referencedRelation: "academy_modules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_tasks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "academy_tasks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      access_credentials: {
        Row: {
          account_ref: string | null
          created_at: string
          created_by: string | null
          expires_on: string | null
          holder_count: number | null
          holder_employee_id: string | null
          holder_name: string | null
          id: string
          kind: string | null
          label: string
          last_rotated_on: string | null
          login_url: string | null
          notes: string | null
          stored_in: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          account_ref?: string | null
          created_at?: string
          created_by?: string | null
          expires_on?: string | null
          holder_count?: number | null
          holder_employee_id?: string | null
          holder_name?: string | null
          id?: string
          kind?: string | null
          label: string
          last_rotated_on?: string | null
          login_url?: string | null
          notes?: string | null
          stored_in?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          account_ref?: string | null
          created_at?: string
          created_by?: string | null
          expires_on?: string | null
          holder_count?: number | null
          holder_employee_id?: string | null
          holder_name?: string | null
          id?: string
          kind?: string | null
          label?: string
          last_rotated_on?: string | null
          login_url?: string | null
          notes?: string | null
          stored_in?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "access_credentials_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "access_credentials_holder_employee_id_fkey"
            columns: ["holder_employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "access_credentials_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "access_credentials_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      activity_log: {
        Row: {
          action: string
          actor_label: string | null
          changes: Json | null
          created_at: string
          entity: string
          entity_id: string | null
          id: number
          label: string | null
          tenant_id: string
          user_id: string | null
        }
        Insert: {
          action: string
          actor_label?: string | null
          changes?: Json | null
          created_at?: string
          entity: string
          entity_id?: string | null
          id?: never
          label?: string | null
          tenant_id: string
          user_id?: string | null
        }
        Update: {
          action?: string
          actor_label?: string | null
          changes?: Json | null
          created_at?: string
          entity?: string
          entity_id?: string | null
          id?: never
          label?: string | null
          tenant_id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "activity_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_log_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      ad_accounts: {
        Row: {
          access_token: string | null
          account_id: string
          connected_user_id: string | null
          created_at: string
          currency: string
          enabled: boolean
          id: string
          last_error: string | null
          last_synced_at: string | null
          login_customer_id: string | null
          name: string
          platform: string
          tenant_id: string
          token_expires_at: string | null
          updated_at: string
        }
        Insert: {
          access_token?: string | null
          account_id: string
          connected_user_id?: string | null
          created_at?: string
          currency?: string
          enabled?: boolean
          id?: string
          last_error?: string | null
          last_synced_at?: string | null
          login_customer_id?: string | null
          name: string
          platform: string
          tenant_id: string
          token_expires_at?: string | null
          updated_at?: string
        }
        Update: {
          access_token?: string | null
          account_id?: string
          connected_user_id?: string | null
          created_at?: string
          currency?: string
          enabled?: boolean
          id?: string
          last_error?: string | null
          last_synced_at?: string | null
          login_customer_id?: string | null
          name?: string
          platform?: string
          tenant_id?: string
          token_expires_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ad_accounts_connected_user_id_fkey"
            columns: ["connected_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ad_accounts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ad_accounts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      ad_spend_daily: {
        Row: {
          ad_account_id: string
          campaign_id: string
          campaign_name: string
          clicks: number
          conversion_value: number
          conversions: number
          day: string
          impressions: number
          spend: number
          tenant_id: string
        }
        Insert: {
          ad_account_id: string
          campaign_id: string
          campaign_name: string
          clicks?: number
          conversion_value?: number
          conversions?: number
          day: string
          impressions?: number
          spend?: number
          tenant_id: string
        }
        Update: {
          ad_account_id?: string
          campaign_id?: string
          campaign_name?: string
          clicks?: number
          conversion_value?: number
          conversions?: number
          day?: string
          impressions?: number
          spend?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ad_spend_daily_ad_account_id_fkey"
            columns: ["ad_account_id"]
            isOneToOne: false
            referencedRelation: "ad_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ad_spend_daily_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ad_spend_daily_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      ad_sync_runs: {
        Row: {
          accounts: number
          error: string | null
          finished_at: string | null
          id: string
          ok: boolean | null
          rows_written: number
          started_at: string
          tenant_id: string
          trigger: string
        }
        Insert: {
          accounts?: number
          error?: string | null
          finished_at?: string | null
          id?: string
          ok?: boolean | null
          rows_written?: number
          started_at?: string
          tenant_id: string
          trigger: string
        }
        Update: {
          accounts?: number
          error?: string | null
          finished_at?: string | null
          id?: string
          ok?: boolean | null
          rows_written?: number
          started_at?: string
          tenant_id?: string
          trigger?: string
        }
        Relationships: [
          {
            foreignKeyName: "ad_sync_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ad_sync_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_action_log: {
        Row: {
          action: string
          created_at: string
          entity: string | null
          entity_id: string | null
          facts: Json
          id: number
          mode: string
          outcome: string
          reason: string
          tenant_id: string
        }
        Insert: {
          action: string
          created_at?: string
          entity?: string | null
          entity_id?: string | null
          facts?: Json
          id?: number
          mode: string
          outcome: string
          reason: string
          tenant_id: string
        }
        Update: {
          action?: string
          created_at?: string
          entity?: string | null
          entity_id?: string | null
          facts?: Json
          id?: number
          mode?: string
          outcome?: string
          reason?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_action_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_action_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_autonomy: {
        Row: {
          action: string
          mode: string
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          action: string
          mode: string
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          action?: string
          mode?: string
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_autonomy_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_autonomy_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_autonomy_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_draft_feedback: {
        Row: {
          action: string
          created_at: string
          draft_body: string
          draft_subject: string | null
          entity: string
          entity_id: string
          id: string
          sent_body: string
          sent_by: string | null
          sent_subject: string | null
          similarity: number
          tenant_id: string
          verdict: string
          words_added: string[]
          words_removed: string[]
        }
        Insert: {
          action: string
          created_at?: string
          draft_body: string
          draft_subject?: string | null
          entity: string
          entity_id: string
          id?: string
          sent_body: string
          sent_by?: string | null
          sent_subject?: string | null
          similarity: number
          tenant_id: string
          verdict: string
          words_added?: string[]
          words_removed?: string[]
        }
        Update: {
          action?: string
          created_at?: string
          draft_body?: string
          draft_subject?: string | null
          entity?: string
          entity_id?: string
          id?: string
          sent_body?: string
          sent_by?: string | null
          sent_subject?: string | null
          similarity?: number
          tenant_id?: string
          verdict?: string
          words_added?: string[]
          words_removed?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "ai_draft_feedback_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_draft_feedback_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_sales_conversations: {
        Row: {
          channel: string
          confidence_score: number | null
          content: string
          created_at: string
          customer_contact: string
          id: string
          intent: string | null
          lead_id: string | null
          role: string
          sentiment: string | null
          tenant_id: string
        }
        Insert: {
          channel: string
          confidence_score?: number | null
          content: string
          created_at?: string
          customer_contact: string
          id?: string
          intent?: string | null
          lead_id?: string | null
          role: string
          sentiment?: string | null
          tenant_id: string
        }
        Update: {
          channel?: string
          confidence_score?: number | null
          content?: string
          created_at?: string
          customer_contact?: string
          id?: string
          intent?: string | null
          lead_id?: string | null
          role?: string
          sentiment?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_sales_conversations_lead_fk"
            columns: ["tenant_id", "lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "ai_sales_conversations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_sales_conversations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_sales_loops: {
        Row: {
          channel: string
          created_at: string
          id: string
          lead_id: string
          processed_at: string | null
          scheduled_at: string
          sent_channel: string | null
          status: string
          step: number
          tenant_id: string
          trigger_condition: string
        }
        Insert: {
          channel?: string
          created_at?: string
          id?: string
          lead_id: string
          processed_at?: string | null
          scheduled_at: string
          sent_channel?: string | null
          status?: string
          step?: number
          tenant_id: string
          trigger_condition: string
        }
        Update: {
          channel?: string
          created_at?: string
          id?: string
          lead_id?: string
          processed_at?: string | null
          scheduled_at?: string
          sent_channel?: string | null
          status?: string
          step?: number
          tenant_id?: string
          trigger_condition?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_sales_loops_lead_fk"
            columns: ["tenant_id", "lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "ai_sales_loops_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_sales_loops_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_support_conversations: {
        Row: {
          channel: string
          confidence_score: number | null
          created_at: string
          customer_contact: string
          id: string
          intent: string | null
          message_content: string
          resolution_status: string | null
          role: string
          tenant_id: string
          ticket_id: string | null
        }
        Insert: {
          channel: string
          confidence_score?: number | null
          created_at?: string
          customer_contact: string
          id?: string
          intent?: string | null
          message_content: string
          resolution_status?: string | null
          role: string
          tenant_id: string
          ticket_id?: string | null
        }
        Update: {
          channel?: string
          confidence_score?: number | null
          created_at?: string
          customer_contact?: string
          id?: string
          intent?: string | null
          message_content?: string
          resolution_status?: string | null
          role?: string
          tenant_id?: string
          ticket_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_support_conversations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_support_conversations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_support_conversations_ticket_fk"
            columns: ["tenant_id", "ticket_id"]
            isOneToOne: false
            referencedRelation: "support_tickets"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      ai_telecall_logs: {
        Row: {
          action_taken: string
          autonomy_mode: string | null
          call_plan: Json
          call_type: string
          created_at: string
          duration_sec: number | null
          id: string
          lead_id: string | null
          phone_number: string
          provider: string
          provider_call_id: string | null
          refusal_reason: string | null
          sentiment: string | null
          status: string
          subscription_id: string | null
          summary: string | null
          tenant_id: string
          transcript: string | null
          updated_at: string
        }
        Insert: {
          action_taken?: string
          autonomy_mode?: string | null
          call_plan?: Json
          call_type: string
          created_at?: string
          duration_sec?: number | null
          id?: string
          lead_id?: string | null
          phone_number: string
          provider?: string
          provider_call_id?: string | null
          refusal_reason?: string | null
          sentiment?: string | null
          status?: string
          subscription_id?: string | null
          summary?: string | null
          tenant_id: string
          transcript?: string | null
          updated_at?: string
        }
        Update: {
          action_taken?: string
          autonomy_mode?: string | null
          call_plan?: Json
          call_type?: string
          created_at?: string
          duration_sec?: number | null
          id?: string
          lead_id?: string | null
          phone_number?: string
          provider?: string
          provider_call_id?: string | null
          refusal_reason?: string | null
          sentiment?: string | null
          status?: string
          subscription_id?: string | null
          summary?: string | null
          tenant_id?: string
          transcript?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_telecall_logs_lead_fk"
            columns: ["tenant_id", "lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "ai_telecall_logs_subscription_fk"
            columns: ["tenant_id", "subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "ai_telecall_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_telecall_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      api_keys: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          key_hash: string
          key_prefix: string
          label: string
          last_used_at: string | null
          revoked_at: string | null
          scopes: string[]
          tenant_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          key_hash: string
          key_prefix: string
          label: string
          last_used_at?: string | null
          revoked_at?: string | null
          scopes?: string[]
          tenant_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          key_hash?: string
          key_prefix?: string
          label?: string
          last_used_at?: string | null
          revoked_at?: string | null
          scopes?: string[]
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "api_keys_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "api_keys_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "api_keys_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      assessment_attempts: {
        Row: {
          answers: Json
          assessment_id: string
          candidate_name: string
          duration_seconds: number | null
          employee_id: string | null
          focus_lost_count: number
          focus_lost_seconds: number
          grade: string
          id: string
          paste_count: number
          pct: number
          score: number
          submitted_at: string
          tenant_id: string
          total: number
        }
        Insert: {
          answers?: Json
          assessment_id: string
          candidate_name: string
          duration_seconds?: number | null
          employee_id?: string | null
          focus_lost_count?: number
          focus_lost_seconds?: number
          grade: string
          id?: string
          paste_count?: number
          pct: number
          score: number
          submitted_at?: string
          tenant_id: string
          total: number
        }
        Update: {
          answers?: Json
          assessment_id?: string
          candidate_name?: string
          duration_seconds?: number | null
          employee_id?: string | null
          focus_lost_count?: number
          focus_lost_seconds?: number
          grade?: string
          id?: string
          paste_count?: number
          pct?: number
          score?: number
          submitted_at?: string
          tenant_id?: string
          total?: number
        }
        Relationships: [
          {
            foreignKeyName: "assessment_attempts_assessment_id_fkey"
            columns: ["assessment_id"]
            isOneToOne: false
            referencedRelation: "assessments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assessment_attempts_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assessment_attempts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assessment_attempts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      assessments: {
        Row: {
          created_at: string
          created_by: string | null
          difficulty: string
          id: string
          pass_pct: number
          public_token: string
          questions: Json
          status: string
          tenant_id: string
          title: string
          topic: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          difficulty?: string
          id?: string
          pass_pct?: number
          public_token: string
          questions?: Json
          status?: string
          tenant_id: string
          title: string
          topic?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          difficulty?: string
          id?: string
          pass_pct?: number
          public_token?: string
          questions?: Json
          status?: string
          tenant_id?: string
          title?: string
          topic?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "assessments_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assessments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assessments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      attendance: {
        Row: {
          check_in: string | null
          check_in_device: string | null
          check_out: string | null
          check_out_device: string | null
          created_at: string
          employee_id: string
          flags: string[]
          geo_in: string | null
          geo_out: string | null
          id: string
          marked_ip: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          selfie_in: string | null
          selfie_out: string | null
          source: string
          tenant_id: string
          work_date: string
        }
        Insert: {
          check_in?: string | null
          check_in_device?: string | null
          check_out?: string | null
          check_out_device?: string | null
          created_at?: string
          employee_id: string
          flags?: string[]
          geo_in?: string | null
          geo_out?: string | null
          id?: string
          marked_ip?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          selfie_in?: string | null
          selfie_out?: string | null
          source?: string
          tenant_id: string
          work_date: string
        }
        Update: {
          check_in?: string | null
          check_in_device?: string | null
          check_out?: string | null
          check_out_device?: string | null
          created_at?: string
          employee_id?: string
          flags?: string[]
          geo_in?: string | null
          geo_out?: string | null
          id?: string
          marked_ip?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          selfie_in?: string | null
          selfie_out?: string | null
          source?: string
          tenant_id?: string
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "attendance_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      attendance_reminder_log: {
        Row: {
          claimed_at: string
          devices: number
          error: string | null
          id: string
          kind: string
          sent_at: string | null
          tenant_id: string
          user_id: string
          work_date: string
        }
        Insert: {
          claimed_at?: string
          devices?: number
          error?: string | null
          id?: string
          kind: string
          sent_at?: string | null
          tenant_id: string
          user_id: string
          work_date: string
        }
        Update: {
          claimed_at?: string
          devices?: number
          error?: string | null
          id?: string
          kind?: string
          sent_at?: string | null
          tenant_id?: string
          user_id?: string
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "attendance_reminder_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_reminder_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_reminder_log_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      attendance_settings: {
        Row: {
          allowed_ips: string[]
          presence_secret: string | null
          require_face_match: boolean
          require_presence: boolean
          require_selfie: boolean
          selfie_retention_days: number
          tenant_id: string
          updated_at: string
        }
        Insert: {
          allowed_ips?: string[]
          presence_secret?: string | null
          require_face_match?: boolean
          require_presence?: boolean
          require_selfie?: boolean
          selfie_retention_days?: number
          tenant_id: string
          updated_at?: string
        }
        Update: {
          allowed_ips?: string[]
          presence_secret?: string | null
          require_face_match?: boolean
          require_presence?: boolean
          require_selfie?: boolean
          selfie_retention_days?: number
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "attendance_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      balance_sheet_items: {
        Row: {
          amount: number
          bank_txn_id: string | null
          created_at: string
          id: string
          label: string
          notes: string | null
          section: string
          sort_order: number
          tenant_id: string
          updated_at: string
        }
        Insert: {
          amount?: number
          bank_txn_id?: string | null
          created_at?: string
          id?: string
          label: string
          notes?: string | null
          section: string
          sort_order?: number
          tenant_id: string
          updated_at?: string
        }
        Update: {
          amount?: number
          bank_txn_id?: string | null
          created_at?: string
          id?: string
          label?: string
          notes?: string | null
          section?: string
          sort_order?: number
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "balance_sheet_items_bank_txn_id_fkey"
            columns: ["bank_txn_id"]
            isOneToOne: false
            referencedRelation: "bank_transactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "balance_sheet_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "balance_sheet_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      bank_aa_connections: {
        Row: {
          bank_account_id: string
          consent_expires_at: string | null
          consent_handle_id: string | null
          consent_id: string | null
          consent_payload: Json | null
          created_at: string
          fetch_window_from: string | null
          fetch_window_to: string | null
          id: string
          last_fetch_at: string | null
          last_fetch_count: number | null
          last_fetch_status: string | null
          linked_account_ref: string | null
          next_fetch_after: string | null
          notes: string | null
          provider: string
          status: string
          status_reason: string | null
          tenant_id: string
          updated_at: string
          vua: string
        }
        Insert: {
          bank_account_id: string
          consent_expires_at?: string | null
          consent_handle_id?: string | null
          consent_id?: string | null
          consent_payload?: Json | null
          created_at?: string
          fetch_window_from?: string | null
          fetch_window_to?: string | null
          id?: string
          last_fetch_at?: string | null
          last_fetch_count?: number | null
          last_fetch_status?: string | null
          linked_account_ref?: string | null
          next_fetch_after?: string | null
          notes?: string | null
          provider?: string
          status?: string
          status_reason?: string | null
          tenant_id: string
          updated_at?: string
          vua: string
        }
        Update: {
          bank_account_id?: string
          consent_expires_at?: string | null
          consent_handle_id?: string | null
          consent_id?: string | null
          consent_payload?: Json | null
          created_at?: string
          fetch_window_from?: string | null
          fetch_window_to?: string | null
          id?: string
          last_fetch_at?: string | null
          last_fetch_count?: number | null
          last_fetch_status?: string | null
          linked_account_ref?: string | null
          next_fetch_after?: string | null
          notes?: string | null
          provider?: string
          status?: string
          status_reason?: string | null
          tenant_id?: string
          updated_at?: string
          vua?: string
        }
        Relationships: [
          {
            foreignKeyName: "bank_aa_connections_bank_account_id_fkey"
            columns: ["bank_account_id"]
            isOneToOne: false
            referencedRelation: "bank_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_aa_connections_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_aa_connections_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      bank_accounts: {
        Row: {
          account_number_last4: string | null
          account_type: string
          bank_name: string
          created_at: string
          id: string
          ifsc: string | null
          is_active: boolean
          name: string
          notes: string | null
          opening_balance: number
          opening_balance_date: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          account_number_last4?: string | null
          account_type?: string
          bank_name: string
          created_at?: string
          id?: string
          ifsc?: string | null
          is_active?: boolean
          name: string
          notes?: string | null
          opening_balance?: number
          opening_balance_date?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          account_number_last4?: string | null
          account_type?: string
          bank_name?: string
          created_at?: string
          id?: string
          ifsc?: string | null
          is_active?: boolean
          name?: string
          notes?: string | null
          opening_balance?: number
          opening_balance_date?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bank_accounts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_accounts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      bank_transactions: {
        Row: {
          balance_after: number | null
          bank_account_id: string
          category: string | null
          category_confidence: number | null
          category_source: string | null
          created_at: string
          credit: number
          debit: number
          description: string
          id: string
          imported_at: string
          match_confidence: string | null
          matched_at: string | null
          matched_by: string | null
          matched_to_id: string | null
          matched_to_type: string | null
          reference: string | null
          source: string
          tenant_id: string
          txn_date: string
          updated_at: string
        }
        Insert: {
          balance_after?: number | null
          bank_account_id: string
          category?: string | null
          category_confidence?: number | null
          category_source?: string | null
          created_at?: string
          credit?: number
          debit?: number
          description: string
          id?: string
          imported_at?: string
          match_confidence?: string | null
          matched_at?: string | null
          matched_by?: string | null
          matched_to_id?: string | null
          matched_to_type?: string | null
          reference?: string | null
          source?: string
          tenant_id: string
          txn_date: string
          updated_at?: string
        }
        Update: {
          balance_after?: number | null
          bank_account_id?: string
          category?: string | null
          category_confidence?: number | null
          category_source?: string | null
          created_at?: string
          credit?: number
          debit?: number
          description?: string
          id?: string
          imported_at?: string
          match_confidence?: string | null
          matched_at?: string | null
          matched_by?: string | null
          matched_to_id?: string | null
          matched_to_type?: string | null
          reference?: string | null
          source?: string
          tenant_id?: string
          txn_date?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bank_transactions_bank_account_id_fkey"
            columns: ["bank_account_id"]
            isOneToOne: false
            referencedRelation: "bank_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_transactions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bank_transactions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      business_loan_payments: {
        Row: {
          amount: number
          bank_account_id: string | null
          created_at: string
          expense_id: string | null
          id: string
          interest_part: number
          loan_id: string
          notes: string | null
          paid_on: string
          principal_part: number
          tenant_id: string
        }
        Insert: {
          amount: number
          bank_account_id?: string | null
          created_at?: string
          expense_id?: string | null
          id?: string
          interest_part?: number
          loan_id: string
          notes?: string | null
          paid_on: string
          principal_part: number
          tenant_id: string
        }
        Update: {
          amount?: number
          bank_account_id?: string | null
          created_at?: string
          expense_id?: string | null
          id?: string
          interest_part?: number
          loan_id?: string
          notes?: string | null
          paid_on?: string
          principal_part?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "business_loan_payments_bank_account_id_fkey"
            columns: ["bank_account_id"]
            isOneToOne: false
            referencedRelation: "bank_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_loan_payments_expense_id_fkey"
            columns: ["expense_id"]
            isOneToOne: false
            referencedRelation: "expenses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_loan_payments_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "business_loans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_loan_payments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_loan_payments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      business_loans: {
        Row: {
          created_at: string
          created_by: string | null
          deposit_account_id: string | null
          disbursed_on: string
          emi_amount: number | null
          id: string
          interest_rate: number | null
          lender: string
          notes: string | null
          principal: number
          purpose: string | null
          status: string
          tenant_id: string
          tenure_months: number | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          deposit_account_id?: string | null
          disbursed_on: string
          emi_amount?: number | null
          id?: string
          interest_rate?: number | null
          lender: string
          notes?: string | null
          principal: number
          purpose?: string | null
          status?: string
          tenant_id: string
          tenure_months?: number | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          deposit_account_id?: string | null
          disbursed_on?: string
          emi_amount?: number | null
          id?: string
          interest_rate?: number | null
          lender?: string
          notes?: string | null
          principal?: number
          purpose?: string | null
          status?: string
          tenant_id?: string
          tenure_months?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "business_loans_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_loans_deposit_account_id_fkey"
            columns: ["deposit_account_id"]
            isOneToOne: false
            referencedRelation: "bank_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_loans_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "business_loans_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      campaign_sends: {
        Row: {
          campaign_id: string
          created_at: string
          error_message: string | null
          id: string
          lead_id: string | null
          provider_id: string | null
          recipient_email: string
          recipient_name: string | null
          sent_at: string | null
          status: string
          tenant_id: string
        }
        Insert: {
          campaign_id: string
          created_at?: string
          error_message?: string | null
          id?: string
          lead_id?: string | null
          provider_id?: string | null
          recipient_email: string
          recipient_name?: string | null
          sent_at?: string | null
          status?: string
          tenant_id: string
        }
        Update: {
          campaign_id?: string
          created_at?: string
          error_message?: string | null
          id?: string
          lead_id?: string | null
          provider_id?: string | null
          recipient_email?: string
          recipient_name?: string | null
          sent_at?: string | null
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaign_sends_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_sends_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_sends_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_sends_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      campaign_templates: {
        Row: {
          body_html: string
          body_text: string | null
          category: string
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          is_system: boolean
          name: string
          subject: string
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          body_html: string
          body_text?: string | null
          category?: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          id: string
          is_system?: boolean
          name: string
          subject: string
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          body_html?: string
          body_text?: string | null
          category?: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_system?: boolean
          name?: string
          subject?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaign_templates_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_templates_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      campaigns: {
        Row: {
          audience_filter: Json
          body: string
          body_html: string | null
          created_at: string
          created_by: string | null
          failed_count: number
          id: string
          name: string
          offer_code: string | null
          offer_discount_pct: number | null
          offer_expires_at: string | null
          recipients_count: number
          sent_at: string | null
          sent_count: number
          status: string
          subject: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          audience_filter?: Json
          body: string
          body_html?: string | null
          created_at?: string
          created_by?: string | null
          failed_count?: number
          id: string
          name: string
          offer_code?: string | null
          offer_discount_pct?: number | null
          offer_expires_at?: string | null
          recipients_count?: number
          sent_at?: string | null
          sent_count?: number
          status?: string
          subject: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          audience_filter?: Json
          body?: string
          body_html?: string | null
          created_at?: string
          created_by?: string | null
          failed_count?: number
          id?: string
          name?: string
          offer_code?: string | null
          offer_discount_pct?: number | null
          offer_expires_at?: string | null
          recipients_count?: number
          sent_at?: string | null
          sent_count?: number
          status?: string
          subject?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaigns_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaigns_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      compliance_log: {
        Row: {
          created_at: string
          created_by: string | null
          due_date: string | null
          filed_date: string
          id: string
          notes: string | null
          obligation_key: string
          period_key: string
          period_label: string | null
          reference: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          due_date?: string | null
          filed_date?: string
          id?: string
          notes?: string | null
          obligation_key: string
          period_key: string
          period_label?: string | null
          reference?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          due_date?: string | null
          filed_date?: string
          id?: string
          notes?: string | null
          obligation_key?: string
          period_key?: string
          period_label?: string | null
          reference?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "compliance_log_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compliance_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compliance_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      compliance_reminder_log: {
        Row: {
          days_before: number
          error_message: string | null
          id: string
          obligation_key: string
          period_key: string
          provider_id: string | null
          recipient_email: string
          sent_at: string
          status: string
          tenant_id: string
        }
        Insert: {
          days_before: number
          error_message?: string | null
          id?: string
          obligation_key: string
          period_key: string
          provider_id?: string | null
          recipient_email: string
          sent_at?: string
          status: string
          tenant_id: string
        }
        Update: {
          days_before?: number
          error_message?: string | null
          id?: string
          obligation_key?: string
          period_key?: string
          provider_id?: string | null
          recipient_email?: string
          sent_at?: string
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "compliance_reminder_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "compliance_reminder_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      contact_greeting_log: {
        Row: {
          channel: string
          contact_id: string
          error_message: string | null
          greeting_year: number
          id: number
          kind: string
          provider_id: string | null
          recipient: string | null
          sent_at: string
          status: string
          subject: string | null
          tenant_id: string
        }
        Insert: {
          channel?: string
          contact_id: string
          error_message?: string | null
          greeting_year: number
          id?: never
          kind: string
          provider_id?: string | null
          recipient?: string | null
          sent_at?: string
          status: string
          subject?: string | null
          tenant_id: string
        }
        Update: {
          channel?: string
          contact_id?: string
          error_message?: string | null
          greeting_year?: number
          id?: never
          kind?: string
          provider_id?: string | null
          recipient?: string | null
          sent_at?: string
          status?: string
          subject?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contact_greeting_log_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contact_greeting_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contact_greeting_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      contacts: {
        Row: {
          address: string | null
          anniversary: string | null
          birthday: string | null
          city: string | null
          company: string | null
          created_at: string
          customer_id: string | null
          email: string | null
          emails: Json
          external_id: string | null
          facebook: string | null
          family: string | null
          full_name: string
          google_etag: string | null
          google_synced_at: string | null
          id: string
          imported_by: string | null
          instagram: string | null
          is_primary: boolean
          linkedin: string | null
          nickname: string | null
          notes: string | null
          phone: string | null
          phones: Json
          promoted_at: string | null
          promoted_to_lead_id: string | null
          relationship: string | null
          role: string | null
          source: string
          status: string
          tags: string[] | null
          tenant_id: string
          title: string | null
          twitter: string | null
          updated_at: string
          website: string | null
          whatsapp: string | null
        }
        Insert: {
          address?: string | null
          anniversary?: string | null
          birthday?: string | null
          city?: string | null
          company?: string | null
          created_at?: string
          customer_id?: string | null
          email?: string | null
          emails?: Json
          external_id?: string | null
          facebook?: string | null
          family?: string | null
          full_name: string
          google_etag?: string | null
          google_synced_at?: string | null
          id: string
          imported_by?: string | null
          instagram?: string | null
          is_primary?: boolean
          linkedin?: string | null
          nickname?: string | null
          notes?: string | null
          phone?: string | null
          phones?: Json
          promoted_at?: string | null
          promoted_to_lead_id?: string | null
          relationship?: string | null
          role?: string | null
          source?: string
          status?: string
          tags?: string[] | null
          tenant_id: string
          title?: string | null
          twitter?: string | null
          updated_at?: string
          website?: string | null
          whatsapp?: string | null
        }
        Update: {
          address?: string | null
          anniversary?: string | null
          birthday?: string | null
          city?: string | null
          company?: string | null
          created_at?: string
          customer_id?: string | null
          email?: string | null
          emails?: Json
          external_id?: string | null
          facebook?: string | null
          family?: string | null
          full_name?: string
          google_etag?: string | null
          google_synced_at?: string | null
          id?: string
          imported_by?: string | null
          instagram?: string | null
          is_primary?: boolean
          linkedin?: string | null
          nickname?: string | null
          notes?: string | null
          phone?: string | null
          phones?: Json
          promoted_at?: string | null
          promoted_to_lead_id?: string | null
          relationship?: string | null
          role?: string | null
          source?: string
          status?: string
          tags?: string[] | null
          tenant_id?: string
          title?: string | null
          twitter?: string | null
          updated_at?: string
          website?: string | null
          whatsapp?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "contacts_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_promoted_to_lead_id_fkey"
            columns: ["promoted_to_lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contacts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      contract_amendments: {
        Row: {
          changed_by: string | null
          changes: Json
          created_at: string
          customer_name: string | null
          id: string
          kind: string
          mrr_from: number | null
          mrr_to: number | null
          note: string | null
          seats_from: number | null
          seats_to: number | null
          source: string
          subscription_id: string
          tenant_id: string
        }
        Insert: {
          changed_by?: string | null
          changes?: Json
          created_at?: string
          customer_name?: string | null
          id?: string
          kind: string
          mrr_from?: number | null
          mrr_to?: number | null
          note?: string | null
          seats_from?: number | null
          seats_to?: number | null
          source?: string
          subscription_id: string
          tenant_id: string
        }
        Update: {
          changed_by?: string | null
          changes?: Json
          created_at?: string
          customer_name?: string | null
          id?: string
          kind?: string
          mrr_from?: number | null
          mrr_to?: number | null
          note?: string | null
          seats_from?: number | null
          seats_to?: number | null
          source?: string
          subscription_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contract_amendments_changed_by_fkey"
            columns: ["changed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contract_amendments_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contract_amendments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contract_amendments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      coupon_redemptions: {
        Row: {
          amount_saved: number
          contact_email: string | null
          contact_name: string | null
          coupon_code: string
          id: string
          lead_id: string | null
          quote_id: string | null
          redeemed_at: string
          seats: number | null
          tenant_id: string
          tier_id: string | null
        }
        Insert: {
          amount_saved: number
          contact_email?: string | null
          contact_name?: string | null
          coupon_code: string
          id?: string
          lead_id?: string | null
          quote_id?: string | null
          redeemed_at?: string
          seats?: number | null
          tenant_id: string
          tier_id?: string | null
        }
        Update: {
          amount_saved?: number
          contact_email?: string | null
          contact_name?: string | null
          coupon_code?: string
          id?: string
          lead_id?: string | null
          quote_id?: string | null
          redeemed_at?: string
          seats?: number | null
          tenant_id?: string
          tier_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "coupon_redemptions_coupon_code_fkey"
            columns: ["coupon_code"]
            isOneToOne: false
            referencedRelation: "coupons"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "coupon_redemptions_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "coupon_redemptions_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "coupon_redemptions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "coupon_redemptions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      coupons: {
        Row: {
          applies_to_tier: string | null
          applies_to_vendor: string | null
          code: string
          created_at: string
          created_by: string | null
          description: string | null
          discount_type: string
          discount_value: number
          is_active: boolean
          max_redemptions: number | null
          max_seats: number | null
          min_seats: number
          redemption_count: number
          tenant_id: string
          updated_at: string
          valid_from: string
          valid_until: string | null
        }
        Insert: {
          applies_to_tier?: string | null
          applies_to_vendor?: string | null
          code: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          discount_type?: string
          discount_value: number
          is_active?: boolean
          max_redemptions?: number | null
          max_seats?: number | null
          min_seats?: number
          redemption_count?: number
          tenant_id: string
          updated_at?: string
          valid_from?: string
          valid_until?: string | null
        }
        Update: {
          applies_to_tier?: string | null
          applies_to_vendor?: string | null
          code?: string
          created_at?: string
          created_by?: string | null
          description?: string | null
          discount_type?: string
          discount_value?: number
          is_active?: boolean
          max_redemptions?: number | null
          max_seats?: number | null
          min_seats?: number
          redemption_count?: number
          tenant_id?: string
          updated_at?: string
          valid_from?: string
          valid_until?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "coupons_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "coupons_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      credit_notes: {
        Row: {
          amount: number
          created_at: string
          created_by: string | null
          credit_date: string
          customer_id: string | null
          customer_name: string | null
          id: string
          inter_state: boolean
          invoice_id: string
          notes: string | null
          reason: string | null
          reason_code: string
          tax_amount: number
          tax_rate: number
          taxable_value: number
          tenant_id: string
        }
        Insert: {
          amount: number
          created_at?: string
          created_by?: string | null
          credit_date?: string
          customer_id?: string | null
          customer_name?: string | null
          id: string
          inter_state?: boolean
          invoice_id: string
          notes?: string | null
          reason?: string | null
          reason_code?: string
          tax_amount: number
          tax_rate: number
          taxable_value: number
          tenant_id: string
        }
        Update: {
          amount?: number
          created_at?: string
          created_by?: string | null
          credit_date?: string
          customer_id?: string | null
          customer_name?: string | null
          id?: string
          inter_state?: boolean
          invoice_id?: string
          notes?: string | null
          reason?: string | null
          reason_code?: string
          tax_amount?: number
          tax_rate?: number
          taxable_value?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "credit_notes_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "credit_notes_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "credit_notes_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "credit_notes_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_contacts: {
        Row: {
          contact_id: string
          created_at: string
          customer_id: string
          id: string
          is_primary: boolean
          role: string | null
          tenant_id: string
        }
        Insert: {
          contact_id: string
          created_at?: string
          customer_id: string
          id?: string
          is_primary?: boolean
          role?: string | null
          tenant_id: string
        }
        Update: {
          contact_id?: string
          created_at?: string
          customer_id?: string
          id?: string
          is_primary?: boolean
          role?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_contacts_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_contacts_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_contacts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_contacts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_credits: {
        Row: {
          amount: number
          created_at: string
          customer_id: string
          id: string
          note: string | null
          source: string
          source_payment_id: string | null
          source_quote_id: string | null
          status: string
          tenant_id: string
        }
        Insert: {
          amount: number
          created_at?: string
          customer_id: string
          id?: string
          note?: string | null
          source?: string
          source_payment_id?: string | null
          source_quote_id?: string | null
          status?: string
          tenant_id: string
        }
        Update: {
          amount?: number
          created_at?: string
          customer_id?: string
          id?: string
          note?: string | null
          source?: string
          source_payment_id?: string | null
          source_quote_id?: string | null
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_credits_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_credits_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_credits_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_domains: {
        Row: {
          created_at: string
          customer_id: string
          domain: string
          id: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          customer_id: string
          domain: string
          id?: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          customer_id?: string
          domain?: string
          id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_domains_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_domains_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_domains_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_groups: {
        Row: {
          contact_email: string | null
          contact_name: string | null
          contact_phone: string | null
          created_at: string
          created_by: string | null
          id: string
          is_active: boolean
          is_partner: boolean
          name: string
          notes: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          is_partner?: boolean
          name: string
          notes?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          is_partner?: boolean
          name?: string
          notes?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_groups_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_groups_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_number_seq: {
        Row: {
          last_number: number
          tenant_id: string
        }
        Insert: {
          last_number?: number
          tenant_id: string
        }
        Update: {
          last_number?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_number_seq_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_number_seq_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_users: {
        Row: {
          auth_user_id: string
          created_at: string
          customer_id: string
          email: string
          id: string
          last_login_at: string | null
          role: string
          tenant_id: string
        }
        Insert: {
          auth_user_id: string
          created_at?: string
          customer_id: string
          email: string
          id?: string
          last_login_at?: string | null
          role?: string
          tenant_id: string
        }
        Update: {
          auth_user_id?: string
          created_at?: string
          customer_id?: string
          email?: string
          id?: string
          last_login_at?: string | null
          role?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_users_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_users_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_users_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      customers: {
        Row: {
          account_manager_id: string | null
          address: string | null
          city: string | null
          contact_email: string | null
          contact_first_name: string | null
          contact_last_name: string | null
          contact_mobile: string | null
          contact_name: string | null
          contact_persons: Json
          contact_phone: string | null
          contact_salutation: string | null
          contact_title: string | null
          country: string
          created_at: string
          customer_number: string | null
          customer_type: string
          display_name: string | null
          domain: string | null
          group_id: string | null
          gstin: string | null
          gstin_verification: Json | null
          gstin_verified_at: string | null
          health: number | null
          id: string
          is_active: boolean
          linked_tenant_id: string | null
          name: string
          notes: string | null
          payment_terms_days: number | null
          pin_code: string | null
          shipping_address: Json | null
          since: string | null
          state: string | null
          state_code: string | null
          tan: string | null
          tds_default_rate_pct: number | null
          tds_default_section: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          account_manager_id?: string | null
          address?: string | null
          city?: string | null
          contact_email?: string | null
          contact_first_name?: string | null
          contact_last_name?: string | null
          contact_mobile?: string | null
          contact_name?: string | null
          contact_persons?: Json
          contact_phone?: string | null
          contact_salutation?: string | null
          contact_title?: string | null
          country?: string
          created_at?: string
          customer_number?: string | null
          customer_type?: string
          display_name?: string | null
          domain?: string | null
          group_id?: string | null
          gstin?: string | null
          gstin_verification?: Json | null
          gstin_verified_at?: string | null
          health?: number | null
          id?: string
          is_active?: boolean
          linked_tenant_id?: string | null
          name: string
          notes?: string | null
          payment_terms_days?: number | null
          pin_code?: string | null
          shipping_address?: Json | null
          since?: string | null
          state?: string | null
          state_code?: string | null
          tan?: string | null
          tds_default_rate_pct?: number | null
          tds_default_section?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          account_manager_id?: string | null
          address?: string | null
          city?: string | null
          contact_email?: string | null
          contact_first_name?: string | null
          contact_last_name?: string | null
          contact_mobile?: string | null
          contact_name?: string | null
          contact_persons?: Json
          contact_phone?: string | null
          contact_salutation?: string | null
          contact_title?: string | null
          country?: string
          created_at?: string
          customer_number?: string | null
          customer_type?: string
          display_name?: string | null
          domain?: string | null
          group_id?: string | null
          gstin?: string | null
          gstin_verification?: Json | null
          gstin_verified_at?: string | null
          health?: number | null
          id?: string
          is_active?: boolean
          linked_tenant_id?: string | null
          name?: string
          notes?: string | null
          payment_terms_days?: number | null
          pin_code?: string | null
          shipping_address?: Json | null
          since?: string | null
          state?: string | null
          state_code?: string | null
          tan?: string | null
          tds_default_rate_pct?: number | null
          tds_default_section?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customers_account_manager_id_fkey"
            columns: ["account_manager_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customers_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "customer_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customers_linked_tenant_id_fkey"
            columns: ["linked_tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customers_linked_tenant_id_fkey"
            columns: ["linked_tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      debit_notes: {
        Row: {
          amount: number
          created_at: string
          created_by: string | null
          customer_id: string | null
          customer_name: string | null
          debit_date: string
          id: string
          inter_state: boolean
          invoice_id: string
          notes: string | null
          reason: string | null
          reason_code: string
          tax_amount: number
          tax_rate: number
          taxable_value: number
          tenant_id: string
        }
        Insert: {
          amount: number
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          customer_name?: string | null
          debit_date?: string
          id: string
          inter_state?: boolean
          invoice_id: string
          notes?: string | null
          reason?: string | null
          reason_code?: string
          tax_amount: number
          tax_rate: number
          taxable_value: number
          tenant_id: string
        }
        Update: {
          amount?: number
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          customer_name?: string | null
          debit_date?: string
          id?: string
          inter_state?: boolean
          invoice_id?: string
          notes?: string | null
          reason?: string | null
          reason_code?: string
          tax_amount?: number
          tax_rate?: number
          taxable_value?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "debit_notes_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "debit_notes_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "debit_notes_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "debit_notes_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      document_series: {
        Row: {
          created_at: string
          doc_type: string
          fiscal_year: string
          last_number: number
          prefix: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          doc_type: string
          fiscal_year: string
          last_number?: number
          prefix: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          doc_type?: string
          fiscal_year?: string
          last_number?: number
          prefix?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_series_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_series_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      documents: {
        Row: {
          category: string
          created_at: string
          expiry_date: string | null
          file_name: string | null
          file_path: string
          id: string
          mime_type: string | null
          notes: string | null
          size_bytes: number | null
          tenant_id: string
          title: string
          updated_at: string
          uploaded_by: string | null
        }
        Insert: {
          category?: string
          created_at?: string
          expiry_date?: string | null
          file_name?: string | null
          file_path: string
          id?: string
          mime_type?: string | null
          notes?: string | null
          size_bytes?: number | null
          tenant_id: string
          title: string
          updated_at?: string
          uploaded_by?: string | null
        }
        Update: {
          category?: string
          created_at?: string
          expiry_date?: string | null
          file_name?: string | null
          file_path?: string
          id?: string
          mime_type?: string | null
          notes?: string | null
          size_bytes?: number | null
          tenant_id?: string
          title?: string
          updated_at?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "documents_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      email_log: {
        Row: {
          created_at: string
          error_message: string | null
          id: string
          kind: string | null
          provider: string
          provider_message_id: string | null
          recipient: string
          status: string
          subject: string | null
          tenant_id: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          id?: string
          kind?: string | null
          provider: string
          provider_message_id?: string | null
          recipient: string
          status: string
          subject?: string | null
          tenant_id: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          error_message?: string | null
          id?: string
          kind?: string | null
          provider?: string
          provider_message_id?: string | null
          recipient?: string
          status?: string
          subject?: string | null
          tenant_id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "email_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_log_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      email_suppressions: {
        Row: {
          campaign_id: string | null
          created_at: string
          email: string
          reason: string
          tenant_id: string
        }
        Insert: {
          campaign_id?: string | null
          created_at?: string
          email: string
          reason?: string
          tenant_id: string
        }
        Update: {
          campaign_id?: string | null
          created_at?: string
          email?: string
          reason?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_suppressions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "email_suppressions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      email_verifications: {
        Row: {
          created_at: string
          email: string
          expires_at: string
          id: string
          token_hash: string
          used_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          email: string
          expires_at: string
          id?: string
          token_hash: string
          used_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          token_hash?: string
          used_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      emi_payments: {
        Row: {
          amount: number
          bank_account_id: string | null
          created_at: string
          expense_id: string | null
          id: string
          interest_part: number
          notes: string | null
          paid_on: string
          principal_part: number
          purchase_id: string
          tenant_id: string
        }
        Insert: {
          amount: number
          bank_account_id?: string | null
          created_at?: string
          expense_id?: string | null
          id?: string
          interest_part?: number
          notes?: string | null
          paid_on: string
          principal_part: number
          purchase_id: string
          tenant_id: string
        }
        Update: {
          amount?: number
          bank_account_id?: string | null
          created_at?: string
          expense_id?: string | null
          id?: string
          interest_part?: number
          notes?: string | null
          paid_on?: string
          principal_part?: number
          purchase_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "emi_payments_bank_account_id_fkey"
            columns: ["bank_account_id"]
            isOneToOne: false
            referencedRelation: "bank_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "emi_payments_expense_id_fkey"
            columns: ["expense_id"]
            isOneToOne: false
            referencedRelation: "expenses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "emi_payments_purchase_id_fkey"
            columns: ["purchase_id"]
            isOneToOne: false
            referencedRelation: "emi_purchases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "emi_payments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "emi_payments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      emi_purchases: {
        Row: {
          category: string
          created_at: string
          created_by: string | null
          down_account_id: string | null
          down_payment: number
          emi_amount: number
          emi_count: number
          financed: number
          id: string
          lender: string | null
          name: string
          notes: string | null
          purchased_on: string
          status: string
          tenant_id: string
          total_cost: number
          updated_at: string
        }
        Insert: {
          category?: string
          created_at?: string
          created_by?: string | null
          down_account_id?: string | null
          down_payment?: number
          emi_amount?: number
          emi_count?: number
          financed: number
          id?: string
          lender?: string | null
          name: string
          notes?: string | null
          purchased_on: string
          status?: string
          tenant_id: string
          total_cost: number
          updated_at?: string
        }
        Update: {
          category?: string
          created_at?: string
          created_by?: string | null
          down_account_id?: string | null
          down_payment?: number
          emi_amount?: number
          emi_count?: number
          financed?: number
          id?: string
          lender?: string | null
          name?: string
          notes?: string | null
          purchased_on?: string
          status?: string
          tenant_id?: string
          total_cost?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "emi_purchases_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "emi_purchases_down_account_id_fkey"
            columns: ["down_account_id"]
            isOneToOne: false
            referencedRelation: "bank_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "emi_purchases_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "emi_purchases_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      employee_assets: {
        Row: {
          created_at: string
          employee_id: string
          fixed_asset_id: string | null
          id: string
          identifier: string | null
          issued_on: string
          kind: string
          name: string
          notes: string | null
          return_condition: string | null
          returned_on: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          employee_id: string
          fixed_asset_id?: string | null
          id?: string
          identifier?: string | null
          issued_on?: string
          kind: string
          name: string
          notes?: string | null
          return_condition?: string | null
          returned_on?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          employee_id?: string
          fixed_asset_id?: string | null
          id?: string
          identifier?: string | null
          issued_on?: string
          kind?: string
          name?: string
          notes?: string | null
          return_condition?: string | null
          returned_on?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "employee_assets_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_assets_fixed_asset_id_fkey"
            columns: ["fixed_asset_id"]
            isOneToOne: false
            referencedRelation: "fixed_assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_assets_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_assets_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      employee_documents: {
        Row: {
          doc_type: string
          employee_id: string
          file_name: string
          file_path: string
          id: string
          mime_type: string | null
          size_bytes: number | null
          tenant_id: string
          uploaded_at: string
          uploaded_by: string | null
        }
        Insert: {
          doc_type?: string
          employee_id: string
          file_name: string
          file_path: string
          id?: string
          mime_type?: string | null
          size_bytes?: number | null
          tenant_id: string
          uploaded_at?: string
          uploaded_by?: string | null
        }
        Update: {
          doc_type?: string
          employee_id?: string
          file_name?: string
          file_path?: string
          id?: string
          mime_type?: string | null
          size_bytes?: number | null
          tenant_id?: string
          uploaded_at?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "employee_documents_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_documents_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_documents_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      employee_loan_repayments: {
        Row: {
          amount: number
          bank_account_id: string | null
          created_at: string
          expense_id: string | null
          id: string
          loan_id: string
          method: string
          notes: string | null
          repaid_on: string
          tenant_id: string
        }
        Insert: {
          amount: number
          bank_account_id?: string | null
          created_at?: string
          expense_id?: string | null
          id?: string
          loan_id: string
          method: string
          notes?: string | null
          repaid_on: string
          tenant_id: string
        }
        Update: {
          amount?: number
          bank_account_id?: string | null
          created_at?: string
          expense_id?: string | null
          id?: string
          loan_id?: string
          method?: string
          notes?: string | null
          repaid_on?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "employee_loan_repayments_bank_account_id_fkey"
            columns: ["bank_account_id"]
            isOneToOne: false
            referencedRelation: "bank_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_loan_repayments_expense_id_fkey"
            columns: ["expense_id"]
            isOneToOne: false
            referencedRelation: "expenses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_loan_repayments_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "employee_loans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_loan_repayments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_loan_repayments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      employee_loans: {
        Row: {
          bank_account_id: string | null
          created_at: string
          created_by: string | null
          disbursed_on: string
          employee_name: string
          id: string
          kind: string
          notes: string | null
          principal: number
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          bank_account_id?: string | null
          created_at?: string
          created_by?: string | null
          disbursed_on: string
          employee_name: string
          id?: string
          kind?: string
          notes?: string | null
          principal: number
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          bank_account_id?: string | null
          created_at?: string
          created_by?: string | null
          disbursed_on?: string
          employee_name?: string
          id?: string
          kind?: string
          notes?: string | null
          principal?: number
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "employee_loans_bank_account_id_fkey"
            columns: ["bank_account_id"]
            isOneToOne: false
            referencedRelation: "bank_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_loans_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_loans_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_loans_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      employees: {
        Row: {
          address: string | null
          attendance_consent_at: string | null
          attendance_consent_source: string | null
          basic_monthly: number | null
          biometric_id: string | null
          created_at: string
          da_monthly: number
          date_of_birth: string | null
          designation: string | null
          email: string | null
          emergency_contact_name: string | null
          emergency_contact_phone: string | null
          esi_applicable: boolean
          esi_no: string | null
          face_enrolled_at: string | null
          face_ref_path: string | null
          id: string
          is_active: boolean
          joining_date: string | null
          leave_allowance: number
          monthly_gross: number
          name: string
          notes: string | null
          pan: string | null
          pf_applicable: boolean
          pf_no: string | null
          phone: string | null
          pin_hash: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          address?: string | null
          attendance_consent_at?: string | null
          attendance_consent_source?: string | null
          basic_monthly?: number | null
          biometric_id?: string | null
          created_at?: string
          da_monthly?: number
          date_of_birth?: string | null
          designation?: string | null
          email?: string | null
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          esi_applicable?: boolean
          esi_no?: string | null
          face_enrolled_at?: string | null
          face_ref_path?: string | null
          id?: string
          is_active?: boolean
          joining_date?: string | null
          leave_allowance?: number
          monthly_gross?: number
          name: string
          notes?: string | null
          pan?: string | null
          pf_applicable?: boolean
          pf_no?: string | null
          phone?: string | null
          pin_hash?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          address?: string | null
          attendance_consent_at?: string | null
          attendance_consent_source?: string | null
          basic_monthly?: number | null
          biometric_id?: string | null
          created_at?: string
          da_monthly?: number
          date_of_birth?: string | null
          designation?: string | null
          email?: string | null
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          esi_applicable?: boolean
          esi_no?: string | null
          face_enrolled_at?: string | null
          face_ref_path?: string | null
          id?: string
          is_active?: boolean
          joining_date?: string | null
          leave_allowance?: number
          monthly_gross?: number
          name?: string
          notes?: string | null
          pan?: string | null
          pf_applicable?: boolean
          pf_no?: string | null
          phone?: string | null
          pin_hash?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "employees_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      expense_claims: {
        Row: {
          amount: number
          category: string
          created_at: string
          employee_id: string
          expense_id: string | null
          id: string
          loan_id: string
          purpose: string | null
          receipt_path: string | null
          reject_reason: string | null
          reviewed_at: string | null
          spent_on: string
          status: string
          tenant_id: string
        }
        Insert: {
          amount: number
          category: string
          created_at?: string
          employee_id: string
          expense_id?: string | null
          id?: string
          loan_id: string
          purpose?: string | null
          receipt_path?: string | null
          reject_reason?: string | null
          reviewed_at?: string | null
          spent_on: string
          status?: string
          tenant_id: string
        }
        Update: {
          amount?: number
          category?: string
          created_at?: string
          employee_id?: string
          expense_id?: string | null
          id?: string
          loan_id?: string
          purpose?: string | null
          receipt_path?: string | null
          reject_reason?: string | null
          reviewed_at?: string | null
          spent_on?: string
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "expense_claims_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_claims_expense_id_fkey"
            columns: ["expense_id"]
            isOneToOne: false
            referencedRelation: "expenses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_claims_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "employee_loans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_claims_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expense_claims_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      expenses: {
        Row: {
          amount: number
          attachment_url: string | null
          bank_account_id: string | null
          bill_no: string | null
          bill_type: string
          campaign_id: string | null
          category: string
          cgst: number | null
          channel: string | null
          created_at: string
          currency: string
          description: string | null
          due_date: string | null
          expense_date: string
          fx_rate: number
          gst_paid: number
          id: string
          igst: number | null
          line_items: Json
          notes: string | null
          paid: boolean
          paid_date: string | null
          payment_method: string | null
          prepaid_advance_id: string | null
          project_id: string | null
          rcm: boolean
          rcm_tax: number
          reconciled_txn_id: string | null
          sgst: number | null
          tds_amount: number
          tds_section: string | null
          tenant_id: string
          updated_at: string
          vendor_id: string | null
          vendor_name: string | null
        }
        Insert: {
          amount: number
          attachment_url?: string | null
          bank_account_id?: string | null
          bill_no?: string | null
          bill_type?: string
          campaign_id?: string | null
          category: string
          cgst?: number | null
          channel?: string | null
          created_at?: string
          currency?: string
          description?: string | null
          due_date?: string | null
          expense_date: string
          fx_rate?: number
          gst_paid?: number
          id: string
          igst?: number | null
          line_items?: Json
          notes?: string | null
          paid?: boolean
          paid_date?: string | null
          payment_method?: string | null
          prepaid_advance_id?: string | null
          project_id?: string | null
          rcm?: boolean
          rcm_tax?: number
          reconciled_txn_id?: string | null
          sgst?: number | null
          tds_amount?: number
          tds_section?: string | null
          tenant_id: string
          updated_at?: string
          vendor_id?: string | null
          vendor_name?: string | null
        }
        Update: {
          amount?: number
          attachment_url?: string | null
          bank_account_id?: string | null
          bill_no?: string | null
          bill_type?: string
          campaign_id?: string | null
          category?: string
          cgst?: number | null
          channel?: string | null
          created_at?: string
          currency?: string
          description?: string | null
          due_date?: string | null
          expense_date?: string
          fx_rate?: number
          gst_paid?: number
          id?: string
          igst?: number | null
          line_items?: Json
          notes?: string | null
          paid?: boolean
          paid_date?: string | null
          payment_method?: string | null
          prepaid_advance_id?: string | null
          project_id?: string | null
          rcm?: boolean
          rcm_tax?: number
          reconciled_txn_id?: string | null
          sgst?: number | null
          tds_amount?: number
          tds_section?: string | null
          tenant_id?: string
          updated_at?: string
          vendor_id?: string | null
          vendor_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "expenses_bank_account_id_fkey"
            columns: ["bank_account_id"]
            isOneToOne: false
            referencedRelation: "bank_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "marketing_campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_prepaid_advance_id_fkey"
            columns: ["prepaid_advance_id"]
            isOneToOne: false
            referencedRelation: "prepaid_advances"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "project_sales"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_reconciled_txn_id_fkey"
            columns: ["reconciled_txn_id"]
            isOneToOne: false
            referencedRelation: "bank_transactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      feedback: {
        Row: {
          ai_chat_summary: string | null
          body: string
          created_at: string
          directive: string | null
          dispatched_at: string | null
          dispatched_by: string | null
          filed_via: string
          id: string
          inferred_type: string | null
          page_path: string | null
          problem_summary: string | null
          reported_by: string | null
          reported_severity: string
          reported_type: string
          reporter_email: string | null
          reporter_name: string | null
          resolution_note: string | null
          resolved_at: string | null
          route_pattern: string | null
          severity_score: number | null
          status: string
          target_files: string[]
          tenant_id: string
          title: string
          triage_mode: string | null
          triage_notes: string[]
          triage_status: string
          triaged_at: string | null
          updated_at: string
        }
        Insert: {
          ai_chat_summary?: string | null
          body: string
          created_at?: string
          directive?: string | null
          dispatched_at?: string | null
          dispatched_by?: string | null
          filed_via?: string
          id?: string
          inferred_type?: string | null
          page_path?: string | null
          problem_summary?: string | null
          reported_by?: string | null
          reported_severity?: string
          reported_type?: string
          reporter_email?: string | null
          reporter_name?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          route_pattern?: string | null
          severity_score?: number | null
          status?: string
          target_files?: string[]
          tenant_id: string
          title: string
          triage_mode?: string | null
          triage_notes?: string[]
          triage_status?: string
          triaged_at?: string | null
          updated_at?: string
        }
        Update: {
          ai_chat_summary?: string | null
          body?: string
          created_at?: string
          directive?: string | null
          dispatched_at?: string | null
          dispatched_by?: string | null
          filed_via?: string
          id?: string
          inferred_type?: string | null
          page_path?: string | null
          problem_summary?: string | null
          reported_by?: string | null
          reported_severity?: string
          reported_type?: string
          reporter_email?: string | null
          reporter_name?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          route_pattern?: string | null
          severity_score?: number | null
          status?: string
          target_files?: string[]
          tenant_id?: string
          title?: string
          triage_mode?: string | null
          triage_notes?: string[]
          triage_status?: string
          triaged_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "feedback_dispatched_by_fkey"
            columns: ["dispatched_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feedback_reported_by_fkey"
            columns: ["reported_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feedback_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feedback_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      feedback_screenshots: {
        Row: {
          byte_size: number | null
          created_at: string
          feedback_id: string
          file_name: string | null
          file_path: string
          id: string
          tenant_id: string
        }
        Insert: {
          byte_size?: number | null
          created_at?: string
          feedback_id: string
          file_name?: string | null
          file_path: string
          id?: string
          tenant_id: string
        }
        Update: {
          byte_size?: number | null
          created_at?: string
          feedback_id?: string
          file_name?: string | null
          file_path?: string
          id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "feedback_screenshots_feedback_id_fkey"
            columns: ["feedback_id"]
            isOneToOne: false
            referencedRelation: "feedback"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feedback_screenshots_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "feedback_screenshots_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      fixed_assets: {
        Row: {
          block: string
          cost: number
          created_at: string
          disposal_value: number
          disposed_on: string | null
          emi_purchase_id: string | null
          expense_id: string | null
          id: string
          name: string
          notes: string | null
          put_to_use: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          block: string
          cost: number
          created_at?: string
          disposal_value?: number
          disposed_on?: string | null
          emi_purchase_id?: string | null
          expense_id?: string | null
          id?: string
          name: string
          notes?: string | null
          put_to_use: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          block?: string
          cost?: number
          created_at?: string
          disposal_value?: number
          disposed_on?: string | null
          emi_purchase_id?: string | null
          expense_id?: string | null
          id?: string
          name?: string
          notes?: string | null
          put_to_use?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "fixed_assets_emi_purchase_id_fkey"
            columns: ["emi_purchase_id"]
            isOneToOne: false
            referencedRelation: "emi_purchases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fixed_assets_expense_id_fkey"
            columns: ["expense_id"]
            isOneToOne: false
            referencedRelation: "expenses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fixed_assets_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fixed_assets_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      gbp_locations: {
        Row: {
          account_name: string
          address: string | null
          average_rating: number | null
          connected_user_id: string
          created_at: string
          id: string
          is_verified: boolean | null
          last_error: string | null
          last_synced_at: string | null
          location_name: string
          maps_uri: string | null
          new_review_uri: string | null
          phone: string | null
          place_id: string | null
          primary_category: string | null
          tenant_id: string
          title: string
          total_reviews: number
          updated_at: string
          website_uri: string | null
        }
        Insert: {
          account_name: string
          address?: string | null
          average_rating?: number | null
          connected_user_id: string
          created_at?: string
          id?: string
          is_verified?: boolean | null
          last_error?: string | null
          last_synced_at?: string | null
          location_name: string
          maps_uri?: string | null
          new_review_uri?: string | null
          phone?: string | null
          place_id?: string | null
          primary_category?: string | null
          tenant_id: string
          title: string
          total_reviews?: number
          updated_at?: string
          website_uri?: string | null
        }
        Update: {
          account_name?: string
          address?: string | null
          average_rating?: number | null
          connected_user_id?: string
          created_at?: string
          id?: string
          is_verified?: boolean | null
          last_error?: string | null
          last_synced_at?: string | null
          location_name?: string
          maps_uri?: string | null
          new_review_uri?: string | null
          phone?: string | null
          place_id?: string | null
          primary_category?: string | null
          tenant_id?: string
          title?: string
          total_reviews?: number
          updated_at?: string
          website_uri?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "gbp_locations_connected_user_id_fkey"
            columns: ["connected_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gbp_locations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gbp_locations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      gbp_metrics_daily: {
        Row: {
          day: string
          location_id: string
          metric: string
          tenant_id: string
          value: number
        }
        Insert: {
          day: string
          location_id: string
          metric: string
          tenant_id: string
          value?: number
        }
        Update: {
          day?: string
          location_id?: string
          metric?: string
          tenant_id?: string
          value?: number
        }
        Relationships: [
          {
            foreignKeyName: "gbp_metrics_daily_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "gbp_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gbp_metrics_daily_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gbp_metrics_daily_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      gbp_reviews: {
        Row: {
          comment: string | null
          created_at: string
          id: string
          is_anonymous: boolean
          location_id: string
          replied_at: string | null
          reply_comment: string | null
          review_name: string
          reviewed_at: string
          reviewer_name: string | null
          reviewer_photo_uri: string | null
          star_rating: number
          tenant_id: string
          updated_at: string
          updated_at_google: string | null
        }
        Insert: {
          comment?: string | null
          created_at?: string
          id?: string
          is_anonymous?: boolean
          location_id: string
          replied_at?: string | null
          reply_comment?: string | null
          review_name: string
          reviewed_at: string
          reviewer_name?: string | null
          reviewer_photo_uri?: string | null
          star_rating: number
          tenant_id: string
          updated_at?: string
          updated_at_google?: string | null
        }
        Update: {
          comment?: string | null
          created_at?: string
          id?: string
          is_anonymous?: boolean
          location_id?: string
          replied_at?: string | null
          reply_comment?: string | null
          review_name?: string
          reviewed_at?: string
          reviewer_name?: string | null
          reviewer_photo_uri?: string | null
          star_rating?: number
          tenant_id?: string
          updated_at?: string
          updated_at_google?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "gbp_reviews_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "gbp_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gbp_reviews_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gbp_reviews_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      gbp_sync_runs: {
        Row: {
          error: string | null
          finished_at: string | null
          id: string
          locations: number
          metric_rows: number
          ok: boolean | null
          reviews: number
          started_at: string
          tenant_id: string
          trigger: string
        }
        Insert: {
          error?: string | null
          finished_at?: string | null
          id?: string
          locations?: number
          metric_rows?: number
          ok?: boolean | null
          reviews?: number
          started_at?: string
          tenant_id: string
          trigger: string
        }
        Update: {
          error?: string | null
          finished_at?: string | null
          id?: string
          locations?: number
          metric_rows?: number
          ok?: boolean | null
          reviews?: number
          started_at?: string
          tenant_id?: string
          trigger?: string
        }
        Relationships: [
          {
            foreignKeyName: "gbp_sync_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gbp_sync_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      google_contact_links: {
        Row: {
          created_at: string
          etag: string | null
          id: string
          resource_name: string
          source_id: string
          source_type: string
          synced_at: string
          tenant_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          etag?: string | null
          id?: string
          resource_name: string
          source_id: string
          source_type: string
          synced_at?: string
          tenant_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          etag?: string | null
          id?: string
          resource_name?: string
          source_id?: string
          source_type?: string
          synced_at?: string
          tenant_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "google_contact_links_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "google_contact_links_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "google_contact_links_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      holidays: {
        Row: {
          created_at: string
          holiday_date: string
          id: string
          name: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          holiday_date: string
          id?: string
          name: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          holiday_date?: string
          id?: string
          name?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "holidays_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "holidays_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      inbound_emails: {
        Row: {
          archived_at: string | null
          attachment_mime: string | null
          attachment_name: string | null
          attachment_path: string | null
          bill_id: string | null
          body_html: string | null
          body_text: string | null
          created_at: string
          extracted_bill: Json | null
          from_email: string | null
          from_name: string | null
          id: string
          in_reply_to: string | null
          lead_id: string | null
          message_id: string
          read_at: string | null
          route: string
          snoozed_until: string | null
          starred: boolean
          status: string
          subject: string | null
          tenant_id: string
          thread_references: string | null
          ticket_id: string | null
          to_email: string | null
        }
        Insert: {
          archived_at?: string | null
          attachment_mime?: string | null
          attachment_name?: string | null
          attachment_path?: string | null
          bill_id?: string | null
          body_html?: string | null
          body_text?: string | null
          created_at?: string
          extracted_bill?: Json | null
          from_email?: string | null
          from_name?: string | null
          id?: string
          in_reply_to?: string | null
          lead_id?: string | null
          message_id: string
          read_at?: string | null
          route?: string
          snoozed_until?: string | null
          starred?: boolean
          status?: string
          subject?: string | null
          tenant_id: string
          thread_references?: string | null
          ticket_id?: string | null
          to_email?: string | null
        }
        Update: {
          archived_at?: string | null
          attachment_mime?: string | null
          attachment_name?: string | null
          attachment_path?: string | null
          bill_id?: string | null
          body_html?: string | null
          body_text?: string | null
          created_at?: string
          extracted_bill?: Json | null
          from_email?: string | null
          from_name?: string | null
          id?: string
          in_reply_to?: string | null
          lead_id?: string | null
          message_id?: string
          read_at?: string | null
          route?: string
          snoozed_until?: string | null
          starred?: boolean
          status?: string
          subject?: string | null
          tenant_id?: string
          thread_references?: string | null
          ticket_id?: string | null
          to_email?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inbound_emails_bill_id_fkey"
            columns: ["bill_id"]
            isOneToOne: false
            referencedRelation: "vendor_bills"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inbound_emails_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inbound_emails_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inbound_emails_ticket_id_fkey"
            columns: ["ticket_id"]
            isOneToOne: false
            referencedRelation: "support_tickets"
            referencedColumns: ["id"]
          },
        ]
      }
      inbound_purchases: {
        Row: {
          created_at: string
          currency: string
          expense_id: string | null
          from_email: string | null
          gst: number | null
          id: number
          items: Json
          message_id: string | null
          order_date: string | null
          order_id: string | null
          raw_text: string | null
          source: string
          status: string
          subject: string | null
          tenant_id: string
          total: number | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          currency?: string
          expense_id?: string | null
          from_email?: string | null
          gst?: number | null
          id?: never
          items?: Json
          message_id?: string | null
          order_date?: string | null
          order_id?: string | null
          raw_text?: string | null
          source?: string
          status?: string
          subject?: string | null
          tenant_id: string
          total?: number | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          currency?: string
          expense_id?: string | null
          from_email?: string | null
          gst?: number | null
          id?: never
          items?: Json
          message_id?: string | null
          order_date?: string | null
          order_id?: string | null
          raw_text?: string | null
          source?: string
          status?: string
          subject?: string | null
          tenant_id?: string
          total?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inbound_purchases_expense_id_fkey"
            columns: ["expense_id"]
            isOneToOne: false
            referencedRelation: "expenses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inbound_purchases_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inbound_purchases_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      indiamart_lead_imports: {
        Row: {
          imported_at: string
          lead_id: string | null
          query_id: string
          query_time: string | null
          query_type: string | null
          tenant_id: string
        }
        Insert: {
          imported_at?: string
          lead_id?: string | null
          query_id: string
          query_time?: string | null
          query_type?: string | null
          tenant_id: string
        }
        Update: {
          imported_at?: string
          lead_id?: string | null
          query_id?: string
          query_time?: string | null
          query_type?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "indiamart_lead_imports_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "indiamart_lead_imports_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "indiamart_lead_imports_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      indiamart_sync_state: {
        Row: {
          last_end_at: string | null
          last_error: string | null
          last_imported: number
          last_ok: boolean | null
          last_run_at: string | null
          next_allowed_at: string | null
          tenant_id: string
        }
        Insert: {
          last_end_at?: string | null
          last_error?: string | null
          last_imported?: number
          last_ok?: boolean | null
          last_run_at?: string | null
          next_allowed_at?: string | null
          tenant_id: string
        }
        Update: {
          last_end_at?: string | null
          last_error?: string | null
          last_imported?: number
          last_ok?: boolean | null
          last_run_at?: string | null
          next_allowed_at?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "indiamart_sync_state_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "indiamart_sync_state_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_dunning_log: {
        Row: {
          action_taken: string
          days_overdue: number
          dunning_step: string
          error_message: string | null
          id: string
          invoice_id: string | null
          recipient_email: string | null
          sent_at: string
          status: string
          subject: string | null
          subscription_id: string | null
          tenant_id: string
        }
        Insert: {
          action_taken?: string
          days_overdue: number
          dunning_step: string
          error_message?: string | null
          id?: string
          invoice_id?: string | null
          recipient_email?: string | null
          sent_at?: string
          status?: string
          subject?: string | null
          subscription_id?: string | null
          tenant_id: string
        }
        Update: {
          action_taken?: string
          days_overdue?: number
          dunning_step?: string
          error_message?: string | null
          id?: string
          invoice_id?: string | null
          recipient_email?: string | null
          sent_at?: string
          status?: string
          subject?: string | null
          subscription_id?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoice_dunning_log_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_dunning_log_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_dunning_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_dunning_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          adjusted_advances: Json
          amount: number
          billing_address: string | null
          created_at: string
          customer_country: string | null
          customer_gstin: string | null
          customer_id: string | null
          customer_name: string
          due_date: string | null
          first_advance_at: string | null
          gst_irn: string | null
          id: string
          inter_state: boolean | null
          invoice_date: string
          line_items: Json | null
          net_payable: number | null
          overdue_days: number | null
          paid_amount: number
          paid_date: string | null
          pdf_url: string | null
          pos_state_code: string | null
          quote_id: string | null
          razorpay_id: string | null
          seller_gstin: string | null
          seller_state_code: string | null
          status: Database["public"]["Enums"]["invoice_status"]
          tax_amount: number | null
          tax_rate: number | null
          taxable_value: number | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          adjusted_advances?: Json
          amount: number
          billing_address?: string | null
          created_at?: string
          customer_country?: string | null
          customer_gstin?: string | null
          customer_id?: string | null
          customer_name: string
          due_date?: string | null
          first_advance_at?: string | null
          gst_irn?: string | null
          id: string
          inter_state?: boolean | null
          invoice_date?: string
          line_items?: Json | null
          net_payable?: number | null
          overdue_days?: number | null
          paid_amount?: number
          paid_date?: string | null
          pdf_url?: string | null
          pos_state_code?: string | null
          quote_id?: string | null
          razorpay_id?: string | null
          seller_gstin?: string | null
          seller_state_code?: string | null
          status?: Database["public"]["Enums"]["invoice_status"]
          tax_amount?: number | null
          tax_rate?: number | null
          taxable_value?: number | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          adjusted_advances?: Json
          amount?: number
          billing_address?: string | null
          created_at?: string
          customer_country?: string | null
          customer_gstin?: string | null
          customer_id?: string | null
          customer_name?: string
          due_date?: string | null
          first_advance_at?: string | null
          gst_irn?: string | null
          id?: string
          inter_state?: boolean | null
          invoice_date?: string
          line_items?: Json | null
          net_payable?: number | null
          overdue_days?: number | null
          paid_amount?: number
          paid_date?: string | null
          pdf_url?: string | null
          pos_state_code?: string | null
          quote_id?: string | null
          razorpay_id?: string | null
          seller_gstin?: string | null
          seller_state_code?: string | null
          status?: Database["public"]["Enums"]["invoice_status"]
          tax_amount?: number | null
          tax_rate?: number | null
          taxable_value?: number | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoices_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      items: {
        Row: {
          covered_product: string | null
          created_at: string
          hsn: string | null
          id: string
          is_active: boolean
          is_partner_visible: boolean
          item_type: string
          kind: string
          margin_pct: number | null
          msrp: number
          name: string
          partner_price: number | null
          prices: Json
          synced_from_partner_id: string | null
          tenant_id: string
          vendor: Database["public"]["Enums"]["vendor"]
          wholesale: number
        }
        Insert: {
          covered_product?: string | null
          created_at?: string
          hsn?: string | null
          id: string
          is_active?: boolean
          is_partner_visible?: boolean
          item_type?: string
          kind?: string
          margin_pct?: number | null
          msrp: number
          name: string
          partner_price?: number | null
          prices?: Json
          synced_from_partner_id?: string | null
          tenant_id: string
          vendor: Database["public"]["Enums"]["vendor"]
          wholesale: number
        }
        Update: {
          covered_product?: string | null
          created_at?: string
          hsn?: string | null
          id?: string
          is_active?: boolean
          is_partner_visible?: boolean
          item_type?: string
          kind?: string
          margin_pct?: number | null
          msrp?: number
          name?: string
          partner_price?: number | null
          prices?: Json
          synced_from_partner_id?: string | null
          tenant_id?: string
          vendor?: Database["public"]["Enums"]["vendor"]
          wholesale?: number
        }
        Relationships: [
          {
            foreignKeyName: "items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      join_requests: {
        Row: {
          auth_user_id: string | null
          created_at: string
          decided_at: string | null
          decided_by: string | null
          email: string
          full_name: string | null
          id: string
          matched_by: string
          note: string | null
          requested_role: Database["public"]["Enums"]["user_role"]
          status: string
          tenant_id: string
        }
        Insert: {
          auth_user_id?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          email: string
          full_name?: string | null
          id?: string
          matched_by: string
          note?: string | null
          requested_role?: Database["public"]["Enums"]["user_role"]
          status?: string
          tenant_id: string
        }
        Update: {
          auth_user_id?: string | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          email?: string
          full_name?: string | null
          id?: string
          matched_by?: string
          note?: string | null
          requested_role?: Database["public"]["Enums"]["user_role"]
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "join_requests_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "join_requests_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "join_requests_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_activities: {
        Row: {
          created_at: string
          created_by: string | null
          detail: string | null
          id: string
          kind: string
          lead_id: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          detail?: string | null
          id?: string
          kind: string
          lead_id: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          detail?: string | null
          id?: string
          kind?: string
          lead_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lead_activities_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_activities_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_activities_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_finder_candidates: {
        Row: {
          city: string | null
          company: string
          created_at: string
          decided_at: string | null
          decided_by: string | null
          description: string | null
          domain: string
          fit_reason: string | null
          id: string
          lead_id: string | null
          mx_provider: string | null
          on_workspace: boolean | null
          pitch: string | null
          product: string | null
          profile_id: string | null
          run_id: string | null
          score: number | null
          signals: Json
          site_https: boolean | null
          site_note: string | null
          site_status: number | null
          source_url: string | null
          status: string
          tenant_id: string
          website: string | null
        }
        Insert: {
          city?: string | null
          company: string
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          description?: string | null
          domain: string
          fit_reason?: string | null
          id?: string
          lead_id?: string | null
          mx_provider?: string | null
          on_workspace?: boolean | null
          pitch?: string | null
          product?: string | null
          profile_id?: string | null
          run_id?: string | null
          score?: number | null
          signals?: Json
          site_https?: boolean | null
          site_note?: string | null
          site_status?: number | null
          source_url?: string | null
          status?: string
          tenant_id: string
          website?: string | null
        }
        Update: {
          city?: string | null
          company?: string
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          description?: string | null
          domain?: string
          fit_reason?: string | null
          id?: string
          lead_id?: string | null
          mx_provider?: string | null
          on_workspace?: boolean | null
          pitch?: string | null
          product?: string | null
          profile_id?: string | null
          run_id?: string | null
          score?: number | null
          signals?: Json
          site_https?: boolean | null
          site_note?: string | null
          site_status?: number | null
          source_url?: string | null
          status?: string
          tenant_id?: string
          website?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lead_finder_candidates_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_finder_candidates_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "lead_finder_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_finder_candidates_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "lead_finder_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_finder_candidates_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_finder_candidates_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_finder_profiles: {
        Row: {
          cities: string
          company_size: string
          created_at: string
          created_by: string | null
          daily_limit: number
          enabled: boolean
          exclude: string
          id: string
          industries: string
          last_run_at: string | null
          must_have: string
          name: string
          products: string[]
          tenant_id: string
          updated_at: string
        }
        Insert: {
          cities?: string
          company_size?: string
          created_at?: string
          created_by?: string | null
          daily_limit?: number
          enabled?: boolean
          exclude?: string
          id?: string
          industries?: string
          last_run_at?: string | null
          must_have?: string
          name: string
          products?: string[]
          tenant_id: string
          updated_at?: string
        }
        Update: {
          cities?: string
          company_size?: string
          created_at?: string
          created_by?: string | null
          daily_limit?: number
          enabled?: boolean
          exclude?: string
          id?: string
          industries?: string
          last_run_at?: string | null
          must_have?: string
          name?: string
          products?: string[]
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lead_finder_profiles_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_finder_profiles_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_finder_runs: {
        Row: {
          discovered: number
          error: string | null
          finished_at: string | null
          id: string
          ok: boolean | null
          profile_id: string | null
          saved: number
          skipped_dupe: number
          started_at: string
          tenant_id: string
          trigger: string
        }
        Insert: {
          discovered?: number
          error?: string | null
          finished_at?: string | null
          id?: string
          ok?: boolean | null
          profile_id?: string | null
          saved?: number
          skipped_dupe?: number
          started_at?: string
          tenant_id: string
          trigger: string
        }
        Update: {
          discovered?: number
          error?: string | null
          finished_at?: string | null
          id?: string
          ok?: boolean | null
          profile_id?: string | null
          saved?: number
          skipped_dupe?: number
          started_at?: string
          tenant_id?: string
          trigger?: string
        }
        Relationships: [
          {
            foreignKeyName: "lead_finder_runs_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "lead_finder_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_finder_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_finder_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      leads: {
        Row: {
          billing_cycle: string | null
          company: string
          contact_email: string | null
          contact_id: string | null
          contact_name: string | null
          contact_phone: string | null
          country: string
          created_at: string
          created_by: string | null
          current_provider: string | null
          customer_id: string | null
          domain: string | null
          enquiry_type: string
          expected_close_date: string | null
          fbclid: string | null
          follow_up_date: string | null
          gclid: string | null
          gstin: string | null
          human_attention_at: string | null
          human_attention_reason: string | null
          id: string
          is_junk: boolean
          junk_note: string | null
          junk_reason: string | null
          junked_at: string | null
          landing_page_url: string | null
          lost_at: string | null
          lost_note: string | null
          lost_reason: string | null
          notes: string | null
          owner_id: string | null
          pipeline: Database["public"]["Enums"]["lead_pipeline"]
          plan: string | null
          priority: string
          project_id: string | null
          project_timeline: string | null
          referrer_url: string | null
          requirement: string | null
          requires_human_attention: boolean
          seats: number | null
          source: string | null
          stage: Database["public"]["Enums"]["lead_stage"]
          stage_changed_at: string | null
          state: string | null
          state_code: string | null
          subscription_type: string | null
          tenant_id: string
          trial_converted_at: string | null
          trial_expired_at: string | null
          trial_expires_at: string | null
          trial_started_at: string | null
          updated_at: string
          utm_campaign: string | null
          utm_medium: string | null
          utm_source: string | null
          value: number | null
          wbraid: string | null
        }
        Insert: {
          billing_cycle?: string | null
          company: string
          contact_email?: string | null
          contact_id?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          country?: string
          created_at?: string
          created_by?: string | null
          current_provider?: string | null
          customer_id?: string | null
          domain?: string | null
          enquiry_type?: string
          expected_close_date?: string | null
          fbclid?: string | null
          follow_up_date?: string | null
          gclid?: string | null
          gstin?: string | null
          human_attention_at?: string | null
          human_attention_reason?: string | null
          id: string
          is_junk?: boolean
          junk_note?: string | null
          junk_reason?: string | null
          junked_at?: string | null
          landing_page_url?: string | null
          lost_at?: string | null
          lost_note?: string | null
          lost_reason?: string | null
          notes?: string | null
          owner_id?: string | null
          pipeline?: Database["public"]["Enums"]["lead_pipeline"]
          plan?: string | null
          priority?: string
          project_id?: string | null
          project_timeline?: string | null
          referrer_url?: string | null
          requirement?: string | null
          requires_human_attention?: boolean
          seats?: number | null
          source?: string | null
          stage?: Database["public"]["Enums"]["lead_stage"]
          stage_changed_at?: string | null
          state?: string | null
          state_code?: string | null
          subscription_type?: string | null
          tenant_id: string
          trial_converted_at?: string | null
          trial_expired_at?: string | null
          trial_expires_at?: string | null
          trial_started_at?: string | null
          updated_at?: string
          utm_campaign?: string | null
          utm_medium?: string | null
          utm_source?: string | null
          value?: number | null
          wbraid?: string | null
        }
        Update: {
          billing_cycle?: string | null
          company?: string
          contact_email?: string | null
          contact_id?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          country?: string
          created_at?: string
          created_by?: string | null
          current_provider?: string | null
          customer_id?: string | null
          domain?: string | null
          enquiry_type?: string
          expected_close_date?: string | null
          fbclid?: string | null
          follow_up_date?: string | null
          gclid?: string | null
          gstin?: string | null
          human_attention_at?: string | null
          human_attention_reason?: string | null
          id?: string
          is_junk?: boolean
          junk_note?: string | null
          junk_reason?: string | null
          junked_at?: string | null
          landing_page_url?: string | null
          lost_at?: string | null
          lost_note?: string | null
          lost_reason?: string | null
          notes?: string | null
          owner_id?: string | null
          pipeline?: Database["public"]["Enums"]["lead_pipeline"]
          plan?: string | null
          priority?: string
          project_id?: string | null
          project_timeline?: string | null
          referrer_url?: string | null
          requirement?: string | null
          requires_human_attention?: boolean
          seats?: number | null
          source?: string | null
          stage?: Database["public"]["Enums"]["lead_stage"]
          stage_changed_at?: string | null
          state?: string | null
          state_code?: string | null
          subscription_type?: string | null
          tenant_id?: string
          trial_converted_at?: string | null
          trial_expired_at?: string | null
          trial_expires_at?: string | null
          trial_started_at?: string | null
          updated_at?: string
          utm_campaign?: string | null
          utm_medium?: string | null
          utm_source?: string | null
          value?: number | null
          wbraid?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "leads_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "project_sales"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      leave_entries: {
        Row: {
          created_at: string
          days: number
          employee_id: string
          from_date: string
          id: string
          notes: string | null
          tenant_id: string
          to_date: string
          type: string
        }
        Insert: {
          created_at?: string
          days: number
          employee_id: string
          from_date: string
          id?: string
          notes?: string | null
          tenant_id: string
          to_date: string
          type: string
        }
        Update: {
          created_at?: string
          days?: number
          employee_id?: string
          from_date?: string
          id?: string
          notes?: string | null
          tenant_id?: string
          to_date?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "leave_entries_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_entries_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_entries_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      marketing_campaigns: {
        Row: {
          budget: number
          cancelled: boolean
          code: string
          created_at: string
          created_by: string | null
          end_date: string
          id: string
          name: string
          notes: string | null
          start_date: string
          target_leads: number | null
          target_won: number | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          budget?: number
          cancelled?: boolean
          code: string
          created_at?: string
          created_by?: string | null
          end_date: string
          id?: string
          name: string
          notes?: string | null
          start_date: string
          target_leads?: number | null
          target_won?: number | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          budget?: number
          cancelled?: boolean
          code?: string
          created_at?: string
          created_by?: string | null
          end_date?: string
          id?: string
          name?: string
          notes?: string | null
          start_date?: string
          target_leads?: number | null
          target_won?: number | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "marketing_campaigns_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "marketing_campaigns_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      marketing_tools: {
        Row: {
          account_url: string | null
          created_at: string
          id: string
          monthly_budget: number
          name: string
          notes: string | null
          owner_name: string | null
          review_link: string | null
          status: string
          tenant_id: string
          tool_key: string
          updated_at: string
        }
        Insert: {
          account_url?: string | null
          created_at?: string
          id?: string
          monthly_budget?: number
          name: string
          notes?: string | null
          owner_name?: string | null
          review_link?: string | null
          status?: string
          tenant_id: string
          tool_key: string
          updated_at?: string
        }
        Update: {
          account_url?: string | null
          created_at?: string
          id?: string
          monthly_budget?: number
          name?: string
          notes?: string | null
          owner_name?: string | null
          review_link?: string | null
          status?: string
          tenant_id?: string
          tool_key?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "marketing_tools_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "marketing_tools_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      month_close_checks: {
        Row: {
          done_at: string
          done_by: string | null
          id: string
          key: string
          note: string | null
          period: string
          tenant_id: string
        }
        Insert: {
          done_at?: string
          done_by?: string | null
          id?: string
          key: string
          note?: string | null
          period: string
          tenant_id: string
        }
        Update: {
          done_at?: string
          done_by?: string | null
          id?: string
          key?: string
          note?: string | null
          period?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "month_close_checks_done_by_fkey"
            columns: ["done_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "month_close_checks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "month_close_checks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      mrr_snapshots: {
        Row: {
          created_at: string
          customer_id: string
          id: string
          mrr: number
          period: string
          subscription_count: number
          tenant_id: string
        }
        Insert: {
          created_at?: string
          customer_id: string
          id?: string
          mrr: number
          period: string
          subscription_count?: number
          tenant_id: string
        }
        Update: {
          created_at?: string
          customer_id?: string
          id?: string
          mrr?: number
          period?: string
          subscription_count?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "mrr_snapshots_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mrr_snapshots_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mrr_snapshots_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          body: string | null
          created_at: string
          entity_id: string | null
          href: string | null
          id: string
          kind: string
          read_at: string | null
          tenant_id: string
          title: string
          user_id: string
        }
        Insert: {
          body?: string | null
          created_at?: string
          entity_id?: string | null
          href?: string | null
          id?: string
          kind: string
          read_at?: string | null
          tenant_id: string
          title: string
          user_id: string
        }
        Update: {
          body?: string | null
          created_at?: string
          entity_id?: string | null
          href?: string | null
          id?: string
          kind?: string
          read_at?: string | null
          tenant_id?: string
          title?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      package_items: {
        Row: {
          created_at: string
          fixed_qty: number | null
          id: string
          item_id: string
          optional: boolean
          package_id: string
          qty_mode: string
          sort_order: number
          tenant_id: string
        }
        Insert: {
          created_at?: string
          fixed_qty?: number | null
          id?: string
          item_id: string
          optional?: boolean
          package_id: string
          qty_mode?: string
          sort_order?: number
          tenant_id: string
        }
        Update: {
          created_at?: string
          fixed_qty?: number | null
          id?: string
          item_id?: string
          optional?: boolean
          package_id?: string
          qty_mode?: string
          sort_order?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "package_items_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "package_items_package_id_fkey"
            columns: ["package_id"]
            isOneToOne: false
            referencedRelation: "packages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "package_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "package_items_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      packages: {
        Row: {
          created_at: string
          discount_pct: number
          id: string
          is_active: boolean
          name: string
          pitch: string | null
          sort_order: number
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          discount_pct?: number
          id?: string
          is_active?: boolean
          name: string
          pitch?: string | null
          sort_order?: number
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          discount_pct?: number
          id?: string
          is_active?: boolean
          name?: string
          pitch?: string | null
          sort_order?: number
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "packages_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "packages_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_mandates: {
        Row: {
          auth_link: string | null
          authorised_at: string | null
          cancelled_at: string | null
          created_at: string
          customer_id: string
          end_date: string | null
          gateway: string
          gateway_customer_id: string | null
          gateway_plan_id: string | null
          gateway_subscription_id: string | null
          id: string
          max_amount: number | null
          method: string
          requested_amount: number
          status: Database["public"]["Enums"]["mandate_status"]
          status_note: string | null
          subscription_id: string | null
          tenant_id: string
          test_mode: boolean
          updated_at: string
        }
        Insert: {
          auth_link?: string | null
          authorised_at?: string | null
          cancelled_at?: string | null
          created_at?: string
          customer_id: string
          end_date?: string | null
          gateway?: string
          gateway_customer_id?: string | null
          gateway_plan_id?: string | null
          gateway_subscription_id?: string | null
          id?: string
          max_amount?: number | null
          method?: string
          requested_amount: number
          status?: Database["public"]["Enums"]["mandate_status"]
          status_note?: string | null
          subscription_id?: string | null
          tenant_id: string
          test_mode?: boolean
          updated_at?: string
        }
        Update: {
          auth_link?: string | null
          authorised_at?: string | null
          cancelled_at?: string | null
          created_at?: string
          customer_id?: string
          end_date?: string | null
          gateway?: string
          gateway_customer_id?: string | null
          gateway_plan_id?: string | null
          gateway_subscription_id?: string | null
          id?: string
          max_amount?: number | null
          method?: string
          requested_amount?: number
          status?: Database["public"]["Enums"]["mandate_status"]
          status_note?: string | null
          subscription_id?: string | null
          tenant_id?: string
          test_mode?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_mandates_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_mandates_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_mandates_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_mandates_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount: number
          bank_account_id: string | null
          created_at: string
          customer_id: string | null
          id: string
          method: string
          notes: string | null
          quote_id: string
          receipt_file_path: string | null
          receipt_voucher_no: string | null
          received_at: string
          recorded_by: string | null
          reference: string | null
          refund_reason: string | null
          refund_voucher_no: string | null
          refunded_at: string | null
          status: string
          tenant_id: string
        }
        Insert: {
          amount: number
          bank_account_id?: string | null
          created_at?: string
          customer_id?: string | null
          id?: string
          method: string
          notes?: string | null
          quote_id: string
          receipt_file_path?: string | null
          receipt_voucher_no?: string | null
          received_at?: string
          recorded_by?: string | null
          reference?: string | null
          refund_reason?: string | null
          refund_voucher_no?: string | null
          refunded_at?: string | null
          status?: string
          tenant_id: string
        }
        Update: {
          amount?: number
          bank_account_id?: string | null
          created_at?: string
          customer_id?: string | null
          id?: string
          method?: string
          notes?: string | null
          quote_id?: string
          receipt_file_path?: string | null
          receipt_voucher_no?: string | null
          received_at?: string
          recorded_by?: string | null
          reference?: string | null
          refund_reason?: string | null
          refund_voucher_no?: string | null
          refunded_at?: string | null
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_bank_account_id_fkey"
            columns: ["bank_account_id"]
            isOneToOne: false
            referencedRelation: "bank_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      personal_accounts: {
        Row: {
          account_last4: string | null
          balance: number
          created_at: string
          credit_limit: number | null
          id: string
          institution: string | null
          interest_rate: number | null
          is_active: boolean
          kind: string
          label: string
          maturity_date: string | null
          notes: string | null
          owner_user_id: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          account_last4?: string | null
          balance?: number
          created_at?: string
          credit_limit?: number | null
          id?: string
          institution?: string | null
          interest_rate?: number | null
          is_active?: boolean
          kind: string
          label: string
          maturity_date?: string | null
          notes?: string | null
          owner_user_id: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          account_last4?: string | null
          balance?: number
          created_at?: string
          credit_limit?: number | null
          id?: string
          institution?: string | null
          interest_rate?: number | null
          is_active?: boolean
          kind?: string
          label?: string
          maturity_date?: string | null
          notes?: string | null
          owner_user_id?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "personal_accounts_owner_user_id_fkey"
            columns: ["owner_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "personal_accounts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "personal_accounts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      personal_holdings: {
        Row: {
          asset_class: string
          created_at: string
          current_value: number
          id: string
          invested: number
          name: string
          notes: string | null
          owner_user_id: string
          tenant_id: string
          units: number | null
          updated_at: string
          valued_on: string | null
        }
        Insert: {
          asset_class: string
          created_at?: string
          current_value?: number
          id?: string
          invested?: number
          name: string
          notes?: string | null
          owner_user_id: string
          tenant_id: string
          units?: number | null
          updated_at?: string
          valued_on?: string | null
        }
        Update: {
          asset_class?: string
          created_at?: string
          current_value?: number
          id?: string
          invested?: number
          name?: string
          notes?: string | null
          owner_user_id?: string
          tenant_id?: string
          units?: number | null
          updated_at?: string
          valued_on?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "personal_holdings_owner_user_id_fkey"
            columns: ["owner_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "personal_holdings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "personal_holdings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      personal_transactions: {
        Row: {
          account_id: string | null
          amount: number
          category: string | null
          created_at: string
          id: string
          kind: string
          note: string | null
          occurred_on: string
          owner_user_id: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          account_id?: string | null
          amount: number
          category?: string | null
          created_at?: string
          id?: string
          kind: string
          note?: string | null
          occurred_on: string
          owner_user_id: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          account_id?: string | null
          amount?: number
          category?: string | null
          created_at?: string
          id?: string
          kind?: string
          note?: string | null
          occurred_on?: string
          owner_user_id?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "personal_transactions_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "personal_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "personal_transactions_owner_user_id_fkey"
            columns: ["owner_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "personal_transactions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "personal_transactions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      personal_vault_pin: {
        Row: {
          created_at: string
          failed_attempts: number
          locked_until: string | null
          pin_hash: string
          pin_salt: string
          tenant_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          failed_attempts?: number
          locked_until?: string | null
          pin_hash: string
          pin_salt: string
          tenant_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          failed_attempts?: number
          locked_until?: string | null
          pin_hash?: string
          pin_salt?: string
          tenant_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "personal_vault_pin_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "personal_vault_pin_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "personal_vault_pin_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      po_bill_allocations: {
        Row: {
          allocated_amount: number
          created_at: string
          created_by: string | null
          id: string
          notes: string | null
          purchase_order_id: string
          tenant_id: string
          vendor_bill_id: string
        }
        Insert: {
          allocated_amount: number
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          purchase_order_id: string
          tenant_id: string
          vendor_bill_id: string
        }
        Update: {
          allocated_amount?: number
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          purchase_order_id?: string
          tenant_id?: string
          vendor_bill_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "po_bill_allocations_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_order_summary"
            referencedColumns: ["purchase_order_id"]
          },
          {
            foreignKeyName: "po_bill_allocations_purchase_order_id_fkey"
            columns: ["purchase_order_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "po_bill_allocations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "po_bill_allocations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "po_bill_allocations_vendor_bill_id_fkey"
            columns: ["vendor_bill_id"]
            isOneToOne: false
            referencedRelation: "vendor_bills"
            referencedColumns: ["id"]
          },
        ]
      }
      prepaid_advances: {
        Row: {
          bank_account_id: string | null
          bank_txn_id: string | null
          category: string
          channel: string | null
          closed_at: string | null
          consumed_amount: number
          created_at: string
          created_by: string | null
          id: string
          notes: string | null
          paid_date: string
          payment_method: string | null
          tenant_id: string
          total_amount: number
          updated_at: string
          vendor_id: string | null
          vendor_name: string
        }
        Insert: {
          bank_account_id?: string | null
          bank_txn_id?: string | null
          category?: string
          channel?: string | null
          closed_at?: string | null
          consumed_amount?: number
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          paid_date?: string
          payment_method?: string | null
          tenant_id: string
          total_amount: number
          updated_at?: string
          vendor_id?: string | null
          vendor_name: string
        }
        Update: {
          bank_account_id?: string | null
          bank_txn_id?: string | null
          category?: string
          channel?: string | null
          closed_at?: string | null
          consumed_amount?: number
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          paid_date?: string
          payment_method?: string | null
          tenant_id?: string
          total_amount?: number
          updated_at?: string
          vendor_id?: string | null
          vendor_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "prepaid_advances_bank_account_id_fkey"
            columns: ["bank_account_id"]
            isOneToOne: false
            referencedRelation: "bank_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prepaid_advances_bank_txn_id_fkey"
            columns: ["bank_txn_id"]
            isOneToOne: false
            referencedRelation: "bank_transactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prepaid_advances_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prepaid_advances_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prepaid_advances_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prepaid_advances_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      project_labour: {
        Row: {
          created_at: string
          employee_id: string
          end_date: string | null
          id: string
          months: number
          note: string | null
          percent: number
          project_id: string
          start_date: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          employee_id: string
          end_date?: string | null
          id?: string
          months?: number
          note?: string | null
          percent?: number
          project_id: string
          start_date?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          employee_id?: string
          end_date?: string | null
          id?: string
          months?: number
          note?: string | null
          percent?: number
          project_id?: string
          start_date?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_labour_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_labour_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "project_sales"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_labour_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_labour_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      project_milestones: {
        Row: {
          created_at: string
          due_date: string | null
          id: string
          invoice_id: string | null
          label: string
          project_id: string
          seq: number
          status: string
          tenant_id: string
          total_amount: number
        }
        Insert: {
          created_at?: string
          due_date?: string | null
          id?: string
          invoice_id?: string | null
          label: string
          project_id: string
          seq?: number
          status?: string
          tenant_id: string
          total_amount: number
        }
        Update: {
          created_at?: string
          due_date?: string | null
          id?: string
          invoice_id?: string | null
          label?: string
          project_id?: string
          seq?: number
          status?: string
          tenant_id?: string
          total_amount?: number
        }
        Relationships: [
          {
            foreignKeyName: "project_milestones_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_milestones_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "project_sales"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_milestones_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_milestones_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      project_payments: {
        Row: {
          amount: number
          bank_txn_id: string | null
          created_at: string
          id: string
          method: string | null
          milestone_id: string | null
          notes: string | null
          project_id: string
          received_at: string
          reference: string | null
          tenant_id: string
        }
        Insert: {
          amount: number
          bank_txn_id?: string | null
          created_at?: string
          id?: string
          method?: string | null
          milestone_id?: string | null
          notes?: string | null
          project_id: string
          received_at?: string
          reference?: string | null
          tenant_id: string
        }
        Update: {
          amount?: number
          bank_txn_id?: string | null
          created_at?: string
          id?: string
          method?: string | null
          milestone_id?: string | null
          notes?: string | null
          project_id?: string
          received_at?: string
          reference?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_payments_bank_txn_id_fkey"
            columns: ["bank_txn_id"]
            isOneToOne: false
            referencedRelation: "bank_transactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_payments_milestone_id_fkey"
            columns: ["milestone_id"]
            isOneToOne: false
            referencedRelation: "project_milestones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_payments_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "project_sales"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_payments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_payments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      project_sales: {
        Row: {
          accepted_at: string | null
          created_at: string
          customer_id: string | null
          customer_name: string
          description: string | null
          gst_amount: number
          gst_rate: number
          id: string
          inter_state: boolean
          line_items: Json
          public_token: string
          sac_code: string
          start_date: string | null
          status: string
          target_date: string | null
          taxable_amount: number
          tenant_id: string
          title: string
          total_amount: number
          updated_at: string
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string
          customer_id?: string | null
          customer_name: string
          description?: string | null
          gst_amount: number
          gst_rate?: number
          id?: string
          inter_state?: boolean
          line_items?: Json
          public_token?: string
          sac_code?: string
          start_date?: string | null
          status?: string
          target_date?: string | null
          taxable_amount: number
          tenant_id: string
          title: string
          total_amount: number
          updated_at?: string
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          customer_id?: string | null
          customer_name?: string
          description?: string | null
          gst_amount?: number
          gst_rate?: number
          id?: string
          inter_state?: boolean
          line_items?: Json
          public_token?: string
          sac_code?: string
          start_date?: string | null
          status?: string
          target_date?: string | null
          taxable_amount?: number
          tenant_id?: string
          title?: string
          total_amount?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_sales_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_sales_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_sales_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      project_tasks: {
        Row: {
          assignee_employee_id: string | null
          created_at: string
          created_by: string | null
          description: string | null
          due_date: string | null
          id: string
          project_id: string
          seq: number
          status: string
          tenant_id: string
          title: string
          updated_at: string
        }
        Insert: {
          assignee_employee_id?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          due_date?: string | null
          id?: string
          project_id: string
          seq?: number
          status?: string
          tenant_id: string
          title: string
          updated_at?: string
        }
        Update: {
          assignee_employee_id?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          due_date?: string | null
          id?: string
          project_id?: string
          seq?: number
          status?: string
          tenant_id?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_tasks_assignee_employee_id_fkey"
            columns: ["assignee_employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_tasks_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "project_sales"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_tasks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_tasks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      provisioning_requests: {
        Row: {
          activated_at: string | null
          amount_paid: number
          blocker: string | null
          created_at: string
          domain: string | null
          id: string
          note: string | null
          payment_mode: string
          plan: string | null
          quote_id: string
          seats: number
          status: string
          tenant_id: string
          updated_at: string
          vendor: string
          vendor_ref: string | null
          years: number
        }
        Insert: {
          activated_at?: string | null
          amount_paid: number
          blocker?: string | null
          created_at?: string
          domain?: string | null
          id?: string
          note?: string | null
          payment_mode: string
          plan?: string | null
          quote_id: string
          seats: number
          status?: string
          tenant_id: string
          updated_at?: string
          vendor: string
          vendor_ref?: string | null
          years?: number
        }
        Update: {
          activated_at?: string | null
          amount_paid?: number
          blocker?: string | null
          created_at?: string
          domain?: string | null
          id?: string
          note?: string | null
          payment_mode?: string
          plan?: string | null
          quote_id?: string
          seats?: number
          status?: string
          tenant_id?: string
          updated_at?: string
          vendor?: string
          vendor_ref?: string | null
          years?: number
        }
        Relationships: [
          {
            foreignKeyName: "provisioning_requests_quote_fk"
            columns: ["tenant_id", "quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "provisioning_requests_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "provisioning_requests_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      provisioning_tasks: {
        Row: {
          completed_at: string | null
          completed_by: string | null
          created_at: string
          domain: string | null
          error_message: string | null
          id: string
          mode: string
          plan: string | null
          quote_id: string
          seats: number | null
          status: string
          tenant_id: string
          updated_at: string
          vendor: string | null
        }
        Insert: {
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          domain?: string | null
          error_message?: string | null
          id?: string
          mode?: string
          plan?: string | null
          quote_id: string
          seats?: number | null
          status?: string
          tenant_id: string
          updated_at?: string
          vendor?: string | null
        }
        Update: {
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          domain?: string | null
          error_message?: string | null
          id?: string
          mode?: string
          plan?: string | null
          quote_id?: string
          seats?: number | null
          status?: string
          tenant_id?: string
          updated_at?: string
          vendor?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "provisioning_tasks_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "provisioning_tasks_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "provisioning_tasks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "provisioning_tasks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_orders: {
        Row: {
          closed_at: string | null
          created_at: string
          created_by: string | null
          customer_id: string | null
          customer_name: string
          domain: string | null
          id: string
          notes: string | null
          placed_at: string | null
          plan: string
          provisioned_at: string | null
          seats: number
          status: string
          subscription_id: string | null
          tenant_id: string
          term_months: number
          total_cost: number
          unit_cost_pm: number
          updated_at: string
          vendor: Database["public"]["Enums"]["vendor"]
          vendor_order_id: string | null
        }
        Insert: {
          closed_at?: string | null
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          customer_name: string
          domain?: string | null
          id: string
          notes?: string | null
          placed_at?: string | null
          plan: string
          provisioned_at?: string | null
          seats: number
          status?: string
          subscription_id?: string | null
          tenant_id: string
          term_months?: number
          total_cost?: number
          unit_cost_pm?: number
          updated_at?: string
          vendor: Database["public"]["Enums"]["vendor"]
          vendor_order_id?: string | null
        }
        Update: {
          closed_at?: string | null
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          customer_name?: string
          domain?: string | null
          id?: string
          notes?: string | null
          placed_at?: string | null
          plan?: string
          provisioned_at?: string | null
          seats?: number
          status?: string
          subscription_id?: string | null
          tenant_id?: string
          term_months?: number
          total_cost?: number
          unit_cost_pm?: number
          updated_at?: string
          vendor?: Database["public"]["Enums"]["vendor"]
          vendor_order_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "purchase_orders_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      push_subscriptions: {
        Row: {
          auth: string
          categories: string[]
          created_at: string
          endpoint: string
          failed_at: string | null
          failure_reason: string | null
          id: string
          last_used_at: string | null
          p256dh: string
          tenant_id: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          auth: string
          categories?: string[]
          created_at?: string
          endpoint: string
          failed_at?: string | null
          failure_reason?: string | null
          id?: string
          last_used_at?: string | null
          p256dh: string
          tenant_id: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          auth?: string
          categories?: string[]
          created_at?: string
          endpoint?: string
          failed_at?: string | null
          failure_reason?: string | null
          id?: string
          last_used_at?: string | null
          p256dh?: string
          tenant_id?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "push_subscriptions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "push_subscriptions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "push_subscriptions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      quote_send_log: {
        Row: {
          cc_emails: string[] | null
          error_message: string | null
          id: string
          provider_id: string | null
          quote_id: string
          recipient_email: string
          sent_at: string
          sent_by: string | null
          status: string
          subject: string | null
          tenant_id: string
        }
        Insert: {
          cc_emails?: string[] | null
          error_message?: string | null
          id?: string
          provider_id?: string | null
          quote_id: string
          recipient_email: string
          sent_at?: string
          sent_by?: string | null
          status: string
          subject?: string | null
          tenant_id: string
        }
        Update: {
          cc_emails?: string[] | null
          error_message?: string | null
          id?: string
          provider_id?: string | null
          quote_id?: string
          recipient_email?: string
          sent_at?: string
          sent_by?: string | null
          status?: string
          subject?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "quote_send_log_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quote_send_log_sent_by_fkey"
            columns: ["sent_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quote_send_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quote_send_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      quote_signatures: {
        Row: {
          created_at: string
          id: string
          quote_id: string
          signed_at: string
          signed_snapshot: Json
          signer_email: string | null
          signer_ip: unknown
          signer_name: string
          signer_title: string | null
          tenant_id: string
          user_agent: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          quote_id: string
          signed_at?: string
          signed_snapshot?: Json
          signer_email?: string | null
          signer_ip?: unknown
          signer_name: string
          signer_title?: string | null
          tenant_id: string
          user_agent?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          quote_id?: string
          signed_at?: string
          signed_snapshot?: Json
          signer_email?: string | null
          signer_ip?: unknown
          signer_name?: string
          signer_title?: string | null
          tenant_id?: string
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "quote_signatures_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quote_signatures_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quote_signatures_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      quote_views: {
        Row: {
          created_at: string
          id: string
          is_bot: boolean
          quote_id: string
          tenant_id: string
          user_agent: string | null
          viewed_at: string
          viewer_hash: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          is_bot?: boolean
          quote_id: string
          tenant_id: string
          user_agent?: string | null
          viewed_at?: string
          viewer_hash?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          is_bot?: boolean
          quote_id?: string
          tenant_id?: string
          user_agent?: string | null
          viewed_at?: string
          viewer_hash?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "quote_views_quote_fk"
            columns: ["tenant_id", "quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "quote_views_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quote_views_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      quotes: {
        Row: {
          amount: number | null
          approval_rejection_reason: string | null
          approval_requested_at: string | null
          approval_requested_by: string | null
          approval_status: Database["public"]["Enums"]["quote_approval_status"]
          approval_tier:
            | Database["public"]["Enums"]["quote_approval_tier"]
            | null
          approved_at: string | null
          approved_by: string | null
          approved_discount_bps: number | null
          approved_margin_bps: number | null
          billing_cycle: string
          created_at: string
          created_date: string
          currency: string
          customer_id: string | null
          customer_name: string
          discount_pct: number | null
          domain: string | null
          exchange_rate: number
          expires_date: string | null
          extension_months: number
          hot_lead_alerted_at: string | null
          id: string
          invoice_id: string | null
          is_add_seats: boolean
          is_extension: boolean
          is_one_off: boolean
          is_renewal: boolean
          lead_id: string | null
          line_items: Json | null
          notes: string | null
          owner_id: string | null
          payment_amount: number | null
          payment_method: string | null
          payment_notes: string | null
          payment_received_at: string | null
          payment_reference: string | null
          payment_status: Database["public"]["Enums"]["payment_status"] | null
          payment_terms_days: number | null
          pdf_url: string | null
          plan: string | null
          prospect_country: string | null
          prospect_state: string | null
          prospect_state_code: string | null
          public_token: string
          seats: number | null
          status: Database["public"]["Enums"]["quote_status"]
          subtotal: number | null
          tax_rate: number | null
          tenant_id: string
          terms_conditions: string | null
          total_cost: number | null
          updated_at: string
        }
        Insert: {
          amount?: number | null
          approval_rejection_reason?: string | null
          approval_requested_at?: string | null
          approval_requested_by?: string | null
          approval_status?: Database["public"]["Enums"]["quote_approval_status"]
          approval_tier?:
            | Database["public"]["Enums"]["quote_approval_tier"]
            | null
          approved_at?: string | null
          approved_by?: string | null
          approved_discount_bps?: number | null
          approved_margin_bps?: number | null
          billing_cycle?: string
          created_at?: string
          created_date?: string
          currency?: string
          customer_id?: string | null
          customer_name: string
          discount_pct?: number | null
          domain?: string | null
          exchange_rate?: number
          expires_date?: string | null
          extension_months?: number
          hot_lead_alerted_at?: string | null
          id: string
          invoice_id?: string | null
          is_add_seats?: boolean
          is_extension?: boolean
          is_one_off?: boolean
          is_renewal?: boolean
          lead_id?: string | null
          line_items?: Json | null
          notes?: string | null
          owner_id?: string | null
          payment_amount?: number | null
          payment_method?: string | null
          payment_notes?: string | null
          payment_received_at?: string | null
          payment_reference?: string | null
          payment_status?: Database["public"]["Enums"]["payment_status"] | null
          payment_terms_days?: number | null
          pdf_url?: string | null
          plan?: string | null
          prospect_country?: string | null
          prospect_state?: string | null
          prospect_state_code?: string | null
          public_token?: string
          seats?: number | null
          status?: Database["public"]["Enums"]["quote_status"]
          subtotal?: number | null
          tax_rate?: number | null
          tenant_id: string
          terms_conditions?: string | null
          total_cost?: number | null
          updated_at?: string
        }
        Update: {
          amount?: number | null
          approval_rejection_reason?: string | null
          approval_requested_at?: string | null
          approval_requested_by?: string | null
          approval_status?: Database["public"]["Enums"]["quote_approval_status"]
          approval_tier?:
            | Database["public"]["Enums"]["quote_approval_tier"]
            | null
          approved_at?: string | null
          approved_by?: string | null
          approved_discount_bps?: number | null
          approved_margin_bps?: number | null
          billing_cycle?: string
          created_at?: string
          created_date?: string
          currency?: string
          customer_id?: string | null
          customer_name?: string
          discount_pct?: number | null
          domain?: string | null
          exchange_rate?: number
          expires_date?: string | null
          extension_months?: number
          hot_lead_alerted_at?: string | null
          id?: string
          invoice_id?: string | null
          is_add_seats?: boolean
          is_extension?: boolean
          is_one_off?: boolean
          is_renewal?: boolean
          lead_id?: string | null
          line_items?: Json | null
          notes?: string | null
          owner_id?: string | null
          payment_amount?: number | null
          payment_method?: string | null
          payment_notes?: string | null
          payment_received_at?: string | null
          payment_reference?: string | null
          payment_status?: Database["public"]["Enums"]["payment_status"] | null
          payment_terms_days?: number | null
          pdf_url?: string | null
          plan?: string | null
          prospect_country?: string | null
          prospect_state?: string | null
          prospect_state_code?: string | null
          public_token?: string
          seats?: number | null
          status?: Database["public"]["Enums"]["quote_status"]
          subtotal?: number | null
          tax_rate?: number | null
          tenant_id?: string
          terms_conditions?: string | null
          total_cost?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "quotes_approval_requested_by_fkey"
            columns: ["approval_requested_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      rate_limit_buckets: {
        Row: {
          hits: number
          key: string
          reset_at: string
        }
        Insert: {
          hits: number
          key: string
          reset_at: string
        }
        Update: {
          hits?: number
          key?: string
          reset_at?: string
        }
        Relationships: []
      }
      referral_agreements: {
        Row: {
          basis: string
          created_at: string
          created_by: string | null
          customer_id: string | null
          deduct_tds: boolean
          fixed_amount: number | null
          id: string
          label: string | null
          notes: string | null
          partner_id: string
          percent: number | null
          quote_id: string | null
          scope: string
          status: string
          subscription_id: string | null
          tds_rate: number
          tenant_id: string
        }
        Insert: {
          basis?: string
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          deduct_tds?: boolean
          fixed_amount?: number | null
          id?: string
          label?: string | null
          notes?: string | null
          partner_id: string
          percent?: number | null
          quote_id?: string | null
          scope?: string
          status?: string
          subscription_id?: string | null
          tds_rate?: number
          tenant_id: string
        }
        Update: {
          basis?: string
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          deduct_tds?: boolean
          fixed_amount?: number | null
          id?: string
          label?: string | null
          notes?: string | null
          partner_id?: string
          percent?: number | null
          quote_id?: string | null
          scope?: string
          status?: string
          subscription_id?: string | null
          tds_rate?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "referral_agreements_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referral_agreements_partner_id_fkey"
            columns: ["partner_id"]
            isOneToOne: false
            referencedRelation: "referral_partners"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referral_agreements_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referral_agreements_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      referral_commissions: {
        Row: {
          agreement_id: string
          base_amount: number
          basis: string
          created_at: string
          customer_id: string | null
          earned_date: string
          gross_commission: number
          id: string
          net_payable: number
          notes: string | null
          paid_date: string | null
          partner_id: string
          pay_txn_id: string | null
          payment_id: string | null
          project_payment_id: string | null
          rate: number | null
          status: string
          tds_amount: number
          tenant_id: string
        }
        Insert: {
          agreement_id: string
          base_amount?: number
          basis: string
          created_at?: string
          customer_id?: string | null
          earned_date?: string
          gross_commission?: number
          id?: string
          net_payable?: number
          notes?: string | null
          paid_date?: string | null
          partner_id: string
          pay_txn_id?: string | null
          payment_id?: string | null
          project_payment_id?: string | null
          rate?: number | null
          status?: string
          tds_amount?: number
          tenant_id: string
        }
        Update: {
          agreement_id?: string
          base_amount?: number
          basis?: string
          created_at?: string
          customer_id?: string | null
          earned_date?: string
          gross_commission?: number
          id?: string
          net_payable?: number
          notes?: string | null
          paid_date?: string | null
          partner_id?: string
          pay_txn_id?: string | null
          payment_id?: string | null
          project_payment_id?: string | null
          rate?: number | null
          status?: string
          tds_amount?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "referral_commissions_agreement_id_fkey"
            columns: ["agreement_id"]
            isOneToOne: false
            referencedRelation: "referral_agreements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referral_commissions_partner_id_fkey"
            columns: ["partner_id"]
            isOneToOne: false
            referencedRelation: "referral_partners"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referral_commissions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referral_commissions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      referral_partners: {
        Row: {
          code: string | null
          created_at: string
          created_by: string | null
          deduct_tds: boolean
          default_basis: string
          default_fixed_amount: number | null
          default_percent: number | null
          email: string | null
          gstin: string | null
          id: string
          is_active: boolean
          name: string
          notes: string | null
          pan: string | null
          phone: string | null
          tds_rate: number
          tenant_id: string
        }
        Insert: {
          code?: string | null
          created_at?: string
          created_by?: string | null
          deduct_tds?: boolean
          default_basis?: string
          default_fixed_amount?: number | null
          default_percent?: number | null
          email?: string | null
          gstin?: string | null
          id?: string
          is_active?: boolean
          name: string
          notes?: string | null
          pan?: string | null
          phone?: string | null
          tds_rate?: number
          tenant_id: string
        }
        Update: {
          code?: string | null
          created_at?: string
          created_by?: string | null
          deduct_tds?: boolean
          default_basis?: string
          default_fixed_amount?: number | null
          default_percent?: number | null
          email?: string | null
          gstin?: string | null
          id?: string
          is_active?: boolean
          name?: string
          notes?: string | null
          pan?: string | null
          phone?: string | null
          tds_rate?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "referral_partners_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referral_partners_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      reimbursements: {
        Row: {
          amount: number
          category: string
          created_at: string
          created_by: string | null
          employee_id: string | null
          expense_id: string | null
          gst_paid: number
          id: string
          incurred_on: string
          paid_via: string | null
          person_name: string
          purpose: string
          receipt_path: string | null
          settled_notes: string | null
          settled_on: string | null
          status: string
          tenant_id: string
        }
        Insert: {
          amount: number
          category?: string
          created_at?: string
          created_by?: string | null
          employee_id?: string | null
          expense_id?: string | null
          gst_paid?: number
          id?: string
          incurred_on: string
          paid_via?: string | null
          person_name: string
          purpose: string
          receipt_path?: string | null
          settled_notes?: string | null
          settled_on?: string | null
          status?: string
          tenant_id: string
        }
        Update: {
          amount?: number
          category?: string
          created_at?: string
          created_by?: string | null
          employee_id?: string | null
          expense_id?: string | null
          gst_paid?: number
          id?: string
          incurred_on?: string
          paid_via?: string | null
          person_name?: string
          purpose?: string
          receipt_path?: string | null
          settled_notes?: string | null
          settled_on?: string | null
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "reimbursements_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reimbursements_expense_id_fkey"
            columns: ["expense_id"]
            isOneToOne: false
            referencedRelation: "expenses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reimbursements_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reimbursements_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      renewal_email_log: {
        Row: {
          cadence_step: Database["public"]["Enums"]["renewal_state"]
          error_message: string | null
          id: string
          provider_id: string | null
          recipient_email: string
          sent_at: string
          status: string
          subject: string | null
          subscription_id: string
          tenant_id: string
        }
        Insert: {
          cadence_step: Database["public"]["Enums"]["renewal_state"]
          error_message?: string | null
          id?: string
          provider_id?: string | null
          recipient_email: string
          sent_at?: string
          status: string
          subject?: string | null
          subscription_id: string
          tenant_id: string
        }
        Update: {
          cadence_step?: Database["public"]["Enums"]["renewal_state"]
          error_message?: string | null
          id?: string
          provider_id?: string | null
          recipient_email?: string
          sent_at?: string
          status?: string
          subject?: string | null
          subscription_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "renewal_email_log_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "renewal_email_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "renewal_email_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      review_requests: {
        Row: {
          channel: string
          created_at: string
          created_by: string | null
          customer_id: string
          error: string | null
          id: string
          sent_to: string | null
          status: string
          tenant_id: string
        }
        Insert: {
          channel: string
          created_at?: string
          created_by?: string | null
          customer_id: string
          error?: string | null
          id?: string
          sent_to?: string | null
          status: string
          tenant_id: string
        }
        Update: {
          channel?: string
          created_at?: string
          created_by?: string | null
          customer_id?: string
          error?: string | null
          id?: string
          sent_to?: string | null
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "review_requests_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_requests_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_requests_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      salary_payments: {
        Row: {
          advance_loan_id: string | null
          advance_recovered: number
          bank_account_id: string | null
          created_at: string
          employee_id: string
          esi: number
          esi_employer: number
          expense_id: string | null
          gross: number
          id: string
          incentive: number
          lop_amount: number
          lop_days: number
          net: number
          notes: string | null
          other_deduction: number
          paid_amount: number
          paid_status: string
          pay_date: string
          performance_points: number
          period: string
          pf: number
          pf_employer: number
          pf_wage: number | null
          reconciled_txn_id: string | null
          tds: number
          tenant_id: string
        }
        Insert: {
          advance_loan_id?: string | null
          advance_recovered?: number
          bank_account_id?: string | null
          created_at?: string
          employee_id: string
          esi?: number
          esi_employer?: number
          expense_id?: string | null
          gross: number
          id?: string
          incentive?: number
          lop_amount?: number
          lop_days?: number
          net: number
          notes?: string | null
          other_deduction?: number
          paid_amount?: number
          paid_status?: string
          pay_date: string
          performance_points?: number
          period: string
          pf?: number
          pf_employer?: number
          pf_wage?: number | null
          reconciled_txn_id?: string | null
          tds?: number
          tenant_id: string
        }
        Update: {
          advance_loan_id?: string | null
          advance_recovered?: number
          bank_account_id?: string | null
          created_at?: string
          employee_id?: string
          esi?: number
          esi_employer?: number
          expense_id?: string | null
          gross?: number
          id?: string
          incentive?: number
          lop_amount?: number
          lop_days?: number
          net?: number
          notes?: string | null
          other_deduction?: number
          paid_amount?: number
          paid_status?: string
          pay_date?: string
          performance_points?: number
          period?: string
          pf?: number
          pf_employer?: number
          pf_wage?: number | null
          reconciled_txn_id?: string | null
          tds?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "salary_payments_advance_loan_id_fkey"
            columns: ["advance_loan_id"]
            isOneToOne: false
            referencedRelation: "employee_loans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "salary_payments_bank_account_id_fkey"
            columns: ["bank_account_id"]
            isOneToOne: false
            referencedRelation: "bank_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "salary_payments_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "salary_payments_expense_id_fkey"
            columns: ["expense_id"]
            isOneToOne: false
            referencedRelation: "expenses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "salary_payments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "salary_payments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      schema_one_off_fixes: {
        Row: {
          applied_at: string
          key: string
          note: string | null
        }
        Insert: {
          applied_at?: string
          key: string
          note?: string | null
        }
        Update: {
          applied_at?: string
          key?: string
          note?: string | null
        }
        Relationships: []
      }
      seat_increase_claims: {
        Row: {
          additional_seats: number
          completed_at: string | null
          created_at: string
          error_code: string | null
          error_message: string | null
          id: string
          idempotency_key: string
          requested_by: string | null
          result: Json | null
          status: string
          subscription_id: string
          tenant_id: string
        }
        Insert: {
          additional_seats: number
          completed_at?: string | null
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          idempotency_key: string
          requested_by?: string | null
          result?: Json | null
          status?: string
          subscription_id: string
          tenant_id: string
        }
        Update: {
          additional_seats?: number
          completed_at?: string | null
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          idempotency_key?: string
          requested_by?: string | null
          result?: Json | null
          status?: string
          subscription_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "seat_increase_claims_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "seat_increase_claims_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "seat_increase_claims_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      seat_requests: {
        Row: {
          created_at: string
          current_seats: number
          customer_id: string | null
          customer_name: string
          decided_at: string | null
          decided_by: string | null
          decision_note: string | null
          effective_on: string | null
          id: string
          note: string | null
          quote_id: string | null
          requested_by_email: string | null
          requested_seats: number
          status: Database["public"]["Enums"]["seat_request_status"]
          subscription_id: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          current_seats: number
          customer_id?: string | null
          customer_name: string
          decided_at?: string | null
          decided_by?: string | null
          decision_note?: string | null
          effective_on?: string | null
          id?: string
          note?: string | null
          quote_id?: string | null
          requested_by_email?: string | null
          requested_seats: number
          status?: Database["public"]["Enums"]["seat_request_status"]
          subscription_id: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          current_seats?: number
          customer_id?: string | null
          customer_name?: string
          decided_at?: string | null
          decided_by?: string | null
          decision_note?: string | null
          effective_on?: string | null
          id?: string
          note?: string | null
          quote_id?: string | null
          requested_by_email?: string | null
          requested_seats?: number
          status?: Database["public"]["Enums"]["seat_request_status"]
          subscription_id?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "seat_requests_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "seat_requests_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "seat_requests_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "seat_requests_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "seat_requests_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "seat_requests_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      site_promos: {
        Row: {
          applies_to_tier: string | null
          applies_to_vendor: string | null
          badge_text: string | null
          banner_style: string
          created_at: string
          created_by: string | null
          discount_type: string
          discount_value: number
          headline: string
          id: string
          is_active: boolean
          max_seats: number | null
          min_seats: number
          subheadline: string | null
          tenant_id: string
          updated_at: string
          valid_from: string
          valid_until: string | null
        }
        Insert: {
          applies_to_tier?: string | null
          applies_to_vendor?: string | null
          badge_text?: string | null
          banner_style?: string
          created_at?: string
          created_by?: string | null
          discount_type: string
          discount_value: number
          headline: string
          id: string
          is_active?: boolean
          max_seats?: number | null
          min_seats?: number
          subheadline?: string | null
          tenant_id: string
          updated_at?: string
          valid_from?: string
          valid_until?: string | null
        }
        Update: {
          applies_to_tier?: string | null
          applies_to_vendor?: string | null
          badge_text?: string | null
          banner_style?: string
          created_at?: string
          created_by?: string | null
          discount_type?: string
          discount_value?: number
          headline?: string
          id?: string
          is_active?: boolean
          max_seats?: number | null
          min_seats?: number
          subheadline?: string | null
          tenant_id?: string
          updated_at?: string
          valid_from?: string
          valid_until?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "site_promos_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "site_promos_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      statutory_dues_payments: {
        Row: {
          amount: number
          bank_account_id: string | null
          bank_txn_id: string | null
          challan_no: string | null
          created_at: string
          id: string
          kind: string
          notes: string | null
          paid_on: string
          period: string | null
          tenant_id: string
        }
        Insert: {
          amount: number
          bank_account_id?: string | null
          bank_txn_id?: string | null
          challan_no?: string | null
          created_at?: string
          id?: string
          kind?: string
          notes?: string | null
          paid_on: string
          period?: string | null
          tenant_id: string
        }
        Update: {
          amount?: number
          bank_account_id?: string | null
          bank_txn_id?: string | null
          challan_no?: string | null
          created_at?: string
          id?: string
          kind?: string
          notes?: string | null
          paid_on?: string
          period?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "statutory_dues_payments_bank_account_id_fkey"
            columns: ["bank_account_id"]
            isOneToOne: false
            referencedRelation: "bank_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "statutory_dues_payments_bank_txn_id_fkey"
            columns: ["bank_txn_id"]
            isOneToOne: false
            referencedRelation: "bank_transactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "statutory_dues_payments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "statutory_dues_payments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      subscription_billings: {
        Row: {
          bill_on: string
          created_at: string
          id: string
          invoice_id: string | null
          period_end: string
          period_index: number
          period_start: string
          subscription_id: string
          tax_rate: number
          taxable_amount: number
          tenant_id: string
          term_start: string
          updated_at: string
        }
        Insert: {
          bill_on: string
          created_at?: string
          id?: string
          invoice_id?: string | null
          period_end: string
          period_index: number
          period_start: string
          subscription_id: string
          tax_rate?: number
          taxable_amount: number
          tenant_id: string
          term_start: string
          updated_at?: string
        }
        Update: {
          bill_on?: string
          created_at?: string
          id?: string
          invoice_id?: string | null
          period_end?: string
          period_index?: number
          period_start?: string
          subscription_id?: string
          tax_rate?: number
          taxable_amount?: number
          tenant_id?: string
          term_start?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscription_billings_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscription_billings_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscription_billings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscription_billings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          auto_renew: boolean
          billing_cycle: Database["public"]["Enums"]["billing_cycle"]
          created_at: string
          customer_id: string | null
          customer_name: string
          domain: string | null
          external_ref: string | null
          id: string
          is_urgent: boolean | null
          item_id: string | null
          last_reminder_at: string | null
          last_reminder_sent_at_v2: string | null
          mrr: number
          outstanding_amount: number
          parent_subscription_id: string | null
          payment_due_date: string | null
          plan: string
          quote_id: string | null
          reminder_count: number
          renewal_date: string | null
          renewal_quote_id: string | null
          renewal_state: Database["public"]["Enums"]["renewal_state"]
          seats: number
          start_date: string | null
          status: Database["public"]["Enums"]["sub_status"]
          suspended_at: string | null
          tenant_id: string
          term_months: number
          updated_at: string
          used: number | null
          used_synced_at: string | null
          vendor: Database["public"]["Enums"]["vendor"]
          vendor_cost_per_seat_month: number | null
          vendor_seats: number | null
          vendor_synced_at: string | null
          write_off_reason: string | null
          written_off_at: string | null
        }
        Insert: {
          auto_renew?: boolean
          billing_cycle?: Database["public"]["Enums"]["billing_cycle"]
          created_at?: string
          customer_id?: string | null
          customer_name: string
          domain?: string | null
          external_ref?: string | null
          id?: string
          is_urgent?: boolean | null
          item_id?: string | null
          last_reminder_at?: string | null
          last_reminder_sent_at_v2?: string | null
          mrr: number
          outstanding_amount?: number
          parent_subscription_id?: string | null
          payment_due_date?: string | null
          plan: string
          quote_id?: string | null
          reminder_count?: number
          renewal_date?: string | null
          renewal_quote_id?: string | null
          renewal_state?: Database["public"]["Enums"]["renewal_state"]
          seats: number
          start_date?: string | null
          status?: Database["public"]["Enums"]["sub_status"]
          suspended_at?: string | null
          tenant_id: string
          term_months?: number
          updated_at?: string
          used?: number | null
          used_synced_at?: string | null
          vendor: Database["public"]["Enums"]["vendor"]
          vendor_cost_per_seat_month?: number | null
          vendor_seats?: number | null
          vendor_synced_at?: string | null
          write_off_reason?: string | null
          written_off_at?: string | null
        }
        Update: {
          auto_renew?: boolean
          billing_cycle?: Database["public"]["Enums"]["billing_cycle"]
          created_at?: string
          customer_id?: string | null
          customer_name?: string
          domain?: string | null
          external_ref?: string | null
          id?: string
          is_urgent?: boolean | null
          item_id?: string | null
          last_reminder_at?: string | null
          last_reminder_sent_at_v2?: string | null
          mrr?: number
          outstanding_amount?: number
          parent_subscription_id?: string | null
          payment_due_date?: string | null
          plan?: string
          quote_id?: string | null
          reminder_count?: number
          renewal_date?: string | null
          renewal_quote_id?: string | null
          renewal_state?: Database["public"]["Enums"]["renewal_state"]
          seats?: number
          start_date?: string | null
          status?: Database["public"]["Enums"]["sub_status"]
          suspended_at?: string | null
          tenant_id?: string
          term_months?: number
          updated_at?: string
          used?: number | null
          used_synced_at?: string | null
          vendor?: Database["public"]["Enums"]["vendor"]
          vendor_cost_per_seat_month?: number | null
          vendor_seats?: number | null
          vendor_synced_at?: string | null
          write_off_reason?: string | null
          written_off_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscriptions_item_fkey"
            columns: ["tenant_id", "item_id"]
            isOneToOne: false
            referencedRelation: "items"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "subscriptions_parent_subscription_id_fkey"
            columns: ["parent_subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscriptions_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscriptions_renewal_quote_id_fkey"
            columns: ["renewal_quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscriptions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscriptions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      support_call_requests: {
        Row: {
          assigned_to: string | null
          created_at: string
          customer_id: string | null
          id: string
          meet_url: string | null
          note: string | null
          requested_by_email: string
          scheduled_at: string | null
          status: string
          tenant_id: string
          ticket_id: string | null
          tier: string
          updated_at: string
        }
        Insert: {
          assigned_to?: string | null
          created_at?: string
          customer_id?: string | null
          id?: string
          meet_url?: string | null
          note?: string | null
          requested_by_email: string
          scheduled_at?: string | null
          status?: string
          tenant_id: string
          ticket_id?: string | null
          tier: string
          updated_at?: string
        }
        Update: {
          assigned_to?: string | null
          created_at?: string
          customer_id?: string | null
          id?: string
          meet_url?: string | null
          note?: string | null
          requested_by_email?: string
          scheduled_at?: string | null
          status?: string
          tenant_id?: string
          ticket_id?: string | null
          tier?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "support_call_requests_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_call_requests_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_call_requests_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_call_requests_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_call_requests_ticket_id_fkey"
            columns: ["ticket_id"]
            isOneToOne: false
            referencedRelation: "support_tickets"
            referencedColumns: ["id"]
          },
        ]
      }
      support_canned_responses: {
        Row: {
          body: string
          created_at: string
          created_by: string | null
          id: string
          tenant_id: string
          title: string
          updated_at: string
          usage_count: number
        }
        Insert: {
          body: string
          created_at?: string
          created_by?: string | null
          id?: string
          tenant_id: string
          title: string
          updated_at?: string
          usage_count?: number
        }
        Update: {
          body?: string
          created_at?: string
          created_by?: string | null
          id?: string
          tenant_id?: string
          title?: string
          updated_at?: string
          usage_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "support_canned_responses_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_canned_responses_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_canned_responses_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      support_plans: {
        Row: {
          annual_price: number
          id: string
          is_active: boolean
          name: string
          sort_order: number
          tenant_id: string
          updated_at: string
        }
        Insert: {
          annual_price?: number
          id: string
          is_active?: boolean
          name: string
          sort_order?: number
          tenant_id: string
          updated_at?: string
        }
        Update: {
          annual_price?: number
          id?: string
          is_active?: boolean
          name?: string
          sort_order?: number
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "support_plans_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_plans_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      support_sync_outbox: {
        Row: {
          attempts: number
          created_at: string
          customer_id: string
          id: string
          last_error: string | null
          payload: Json
          sent_at: string | null
          status: string
          subscription_id: string
          tenant_id: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          customer_id: string
          id?: string
          last_error?: string | null
          payload: Json
          sent_at?: string | null
          status?: string
          subscription_id: string
          tenant_id: string
        }
        Update: {
          attempts?: number
          created_at?: string
          customer_id?: string
          id?: string
          last_error?: string | null
          payload?: Json
          sent_at?: string | null
          status?: string
          subscription_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "support_sync_outbox_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_sync_outbox_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_sync_outbox_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_sync_outbox_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      support_ticket_notes: {
        Row: {
          author_id: string | null
          author_name: string
          body: string
          created_at: string
          id: string
          tenant_id: string
          ticket_id: string
        }
        Insert: {
          author_id?: string | null
          author_name: string
          body: string
          created_at?: string
          id?: string
          tenant_id: string
          ticket_id: string
        }
        Update: {
          author_id?: string | null
          author_name?: string
          body?: string
          created_at?: string
          id?: string
          tenant_id?: string
          ticket_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "support_ticket_notes_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_ticket_notes_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_ticket_notes_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_ticket_notes_tenant_id_ticket_id_fkey"
            columns: ["tenant_id", "ticket_id"]
            isOneToOne: false
            referencedRelation: "support_tickets"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      support_ticket_ratings: {
        Row: {
          comment: string | null
          created_at: string
          id: string
          rated_by_email: string
          score: number
          tenant_id: string
          ticket_id: string
        }
        Insert: {
          comment?: string | null
          created_at?: string
          id?: string
          rated_by_email: string
          score: number
          tenant_id: string
          ticket_id: string
        }
        Update: {
          comment?: string | null
          created_at?: string
          id?: string
          rated_by_email?: string
          score?: number
          tenant_id?: string
          ticket_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "support_ticket_ratings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_ticket_ratings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_ticket_ratings_tenant_id_ticket_id_fkey"
            columns: ["tenant_id", "ticket_id"]
            isOneToOne: true
            referencedRelation: "support_tickets"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      support_ticket_time_logs: {
        Row: {
          created_at: string
          id: string
          minutes: number
          note: string | null
          tenant_id: string
          ticket_id: string
          user_id: string | null
          user_name: string
        }
        Insert: {
          created_at?: string
          id?: string
          minutes: number
          note?: string | null
          tenant_id: string
          ticket_id: string
          user_id?: string | null
          user_name: string
        }
        Update: {
          created_at?: string
          id?: string
          minutes?: number
          note?: string | null
          tenant_id?: string
          ticket_id?: string
          user_id?: string | null
          user_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "support_ticket_time_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_ticket_time_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_ticket_time_logs_tenant_id_ticket_id_fkey"
            columns: ["tenant_id", "ticket_id"]
            isOneToOne: false
            referencedRelation: "support_tickets"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "support_ticket_time_logs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      support_tickets: {
        Row: {
          ai_answered_at: string | null
          ai_awaiting_reply_since: string | null
          ai_escalated: boolean
          ai_escalated_at: string | null
          ai_escalation_reason: string | null
          assigned_agent: string | null
          assigned_at: string | null
          body: string
          category: string
          channel: string | null
          created_at: string
          customer_id: string | null
          customer_name: string
          first_responded_at: string | null
          id: string
          priority: string
          raised_by_email: string
          raised_by_user: string | null
          resolution_note: string | null
          resolved_at: string | null
          resolved_by: string | null
          sla_alert_sent_at: string | null
          sla_due_at: string | null
          status: string
          subject: string
          tenant_id: string
          tier: string | null
          updated_at: string
        }
        Insert: {
          ai_answered_at?: string | null
          ai_awaiting_reply_since?: string | null
          ai_escalated?: boolean
          ai_escalated_at?: string | null
          ai_escalation_reason?: string | null
          assigned_agent?: string | null
          assigned_at?: string | null
          body: string
          category: string
          channel?: string | null
          created_at?: string
          customer_id?: string | null
          customer_name: string
          first_responded_at?: string | null
          id: string
          priority?: string
          raised_by_email: string
          raised_by_user?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          sla_alert_sent_at?: string | null
          sla_due_at?: string | null
          status?: string
          subject: string
          tenant_id: string
          tier?: string | null
          updated_at?: string
        }
        Update: {
          ai_answered_at?: string | null
          ai_awaiting_reply_since?: string | null
          ai_escalated?: boolean
          ai_escalated_at?: string | null
          ai_escalation_reason?: string | null
          assigned_agent?: string | null
          assigned_at?: string | null
          body?: string
          category?: string
          channel?: string | null
          created_at?: string
          customer_id?: string | null
          customer_name?: string
          first_responded_at?: string | null
          id?: string
          priority?: string
          raised_by_email?: string
          raised_by_user?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          sla_alert_sent_at?: string | null
          sla_due_at?: string | null
          status?: string
          subject?: string
          tenant_id?: string
          tier?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "support_tickets_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_tickets_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_tickets_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      task_collaborators: {
        Row: {
          added_by: string | null
          created_at: string
          id: string
          task_id: string
          tenant_id: string
          user_id: string
        }
        Insert: {
          added_by?: string | null
          created_at?: string
          id?: string
          task_id: string
          tenant_id: string
          user_id: string
        }
        Update: {
          added_by?: string | null
          created_at?: string
          id?: string
          task_id?: string
          tenant_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_collaborators_added_by_fkey"
            columns: ["added_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_collaborators_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_collaborators_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_collaborators_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_collaborators_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      task_comments: {
        Row: {
          attachment_name: string | null
          attachment_path: string | null
          content: string
          created_at: string
          edited_at: string | null
          id: string
          mentions: string[]
          task_id: string
          tenant_id: string
          user_id: string
        }
        Insert: {
          attachment_name?: string | null
          attachment_path?: string | null
          content: string
          created_at?: string
          edited_at?: string | null
          id?: string
          mentions?: string[]
          task_id: string
          tenant_id: string
          user_id: string
        }
        Update: {
          attachment_name?: string | null
          attachment_path?: string | null
          content?: string
          created_at?: string
          edited_at?: string | null
          id?: string
          mentions?: string[]
          task_id?: string
          tenant_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_comments_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_comments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_comments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_comments_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      task_kudos: {
        Row: {
          awarded_by: string
          created_at: string
          id: string
          note: string | null
          task_id: string
          tenant_id: string
          user_id: string
        }
        Insert: {
          awarded_by: string
          created_at?: string
          id?: string
          note?: string | null
          task_id: string
          tenant_id: string
          user_id: string
        }
        Update: {
          awarded_by?: string
          created_at?: string
          id?: string
          note?: string | null
          task_id?: string
          tenant_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_kudos_awarded_by_fkey"
            columns: ["awarded_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_kudos_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_kudos_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_kudos_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_kudos_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      tasks: {
        Row: {
          completed_at: string | null
          completed_by: string | null
          created_at: string
          customer_id: string | null
          delegated_at: string | null
          delegated_by: string | null
          due_at: string
          id: string
          kind: Database["public"]["Enums"]["task_kind"]
          lead_id: string | null
          notes: string | null
          owner_id: string | null
          quote_id: string | null
          reminder_minutes_before: number
          snooze_count: number
          status: Database["public"]["Enums"]["task_status"]
          subscription_id: string | null
          tenant_id: string
          title: string
        }
        Insert: {
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          customer_id?: string | null
          delegated_at?: string | null
          delegated_by?: string | null
          due_at: string
          id?: string
          kind?: Database["public"]["Enums"]["task_kind"]
          lead_id?: string | null
          notes?: string | null
          owner_id?: string | null
          quote_id?: string | null
          reminder_minutes_before?: number
          snooze_count?: number
          status?: Database["public"]["Enums"]["task_status"]
          subscription_id?: string | null
          tenant_id: string
          title: string
        }
        Update: {
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          customer_id?: string | null
          delegated_at?: string | null
          delegated_by?: string | null
          due_at?: string
          id?: string
          kind?: Database["public"]["Enums"]["task_kind"]
          lead_id?: string | null
          notes?: string | null
          owner_id?: string | null
          quote_id?: string | null
          reminder_minutes_before?: number
          snooze_count?: number
          status?: Database["public"]["Enums"]["task_status"]
          subscription_id?: string | null
          tenant_id?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "tasks_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_delegated_by_fkey"
            columns: ["delegated_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      tax_payments: {
        Row: {
          amount: number
          bank_account_id: string | null
          bank_txn_id: string | null
          created_at: string
          expense_id: string | null
          fy: string | null
          id: string
          interest: number
          kind: string
          late_fee: number
          notes: string | null
          paid_on: string
          period: string | null
          tenant_id: string
        }
        Insert: {
          amount: number
          bank_account_id?: string | null
          bank_txn_id?: string | null
          created_at?: string
          expense_id?: string | null
          fy?: string | null
          id?: string
          interest?: number
          kind: string
          late_fee?: number
          notes?: string | null
          paid_on: string
          period?: string | null
          tenant_id: string
        }
        Update: {
          amount?: number
          bank_account_id?: string | null
          bank_txn_id?: string | null
          created_at?: string
          expense_id?: string | null
          fy?: string | null
          id?: string
          interest?: number
          kind?: string
          late_fee?: number
          notes?: string | null
          paid_on?: string
          period?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tax_payments_bank_account_id_fkey"
            columns: ["bank_account_id"]
            isOneToOne: false
            referencedRelation: "bank_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tax_payments_bank_txn_id_fkey"
            columns: ["bank_txn_id"]
            isOneToOne: false
            referencedRelation: "bank_transactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tax_payments_expense_id_fkey"
            columns: ["expense_id"]
            isOneToOne: false
            referencedRelation: "expenses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tax_payments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tax_payments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      tds_receivable: {
        Row: {
          appears_in_26as: boolean
          appears_in_26as_date: string | null
          claimed_in_itr: boolean
          claimed_in_itr_date: string | null
          created_at: string
          customer_id: string | null
          customer_name: string
          customer_tan: string | null
          fiscal_year: string
          form_16a_received_date: string | null
          form_16a_url: string | null
          gross_amount: number
          id: string
          invoice_id: string | null
          net_paid: number
          notes: string | null
          payment_id: string | null
          payment_received_date: string
          rate_pct: number
          section: string
          status: string
          tds_amount: number
          tenant_id: string
          updated_at: string
        }
        Insert: {
          appears_in_26as?: boolean
          appears_in_26as_date?: string | null
          claimed_in_itr?: boolean
          claimed_in_itr_date?: string | null
          created_at?: string
          customer_id?: string | null
          customer_name: string
          customer_tan?: string | null
          fiscal_year: string
          form_16a_received_date?: string | null
          form_16a_url?: string | null
          gross_amount: number
          id: string
          invoice_id?: string | null
          net_paid: number
          notes?: string | null
          payment_id?: string | null
          payment_received_date: string
          rate_pct: number
          section: string
          status?: string
          tds_amount: number
          tenant_id: string
          updated_at?: string
        }
        Update: {
          appears_in_26as?: boolean
          appears_in_26as_date?: string | null
          claimed_in_itr?: boolean
          claimed_in_itr_date?: string | null
          created_at?: string
          customer_id?: string | null
          customer_name?: string
          customer_tan?: string | null
          fiscal_year?: string
          form_16a_received_date?: string | null
          form_16a_url?: string | null
          gross_amount?: number
          id?: string
          invoice_id?: string | null
          net_paid?: number
          notes?: string | null
          payment_id?: string | null
          payment_received_date?: string
          rate_pct?: number
          section?: string
          status?: string
          tds_amount?: number
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tds_receivable_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tds_receivable_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tds_receivable_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tds_receivable_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tds_receivable_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      team_invites: {
        Row: {
          accepted_at: string | null
          created_at: string
          email: string
          id: string
          invited_by: string | null
          role: Database["public"]["Enums"]["user_role"]
          tenant_id: string
          token: string
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string
          email: string
          id?: string
          invited_by?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          tenant_id: string
          token?: string
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          email?: string
          id?: string
          invited_by?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          tenant_id?: string
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "team_invites_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_invites_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_invites_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_domains: {
        Row: {
          created_at: string
          created_by: string | null
          domain: string
          id: string
          tenant_id: string
          verified_at: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          domain: string
          id?: string
          tenant_id: string
          verified_at?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          domain?: string
          id?: string
          tenant_id?: string
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tenant_domains_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_domains_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_domains_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_secrets: {
        Row: {
          created_at: string
          gemini_api_key: string | null
          gemini_model: string | null
          indiamart_crm_key: string | null
          razorpay_key_id: string | null
          razorpay_key_secret: string | null
          razorpay_mode: string | null
          razorpay_webhook_secret: string | null
          resend_api_key: string | null
          sandbox_api_base: string | null
          sandbox_api_key: string | null
          sandbox_api_secret: string | null
          tenant_id: string
          updated_at: string
          whatsapp_access_token: string | null
          whatsapp_app_secret: string | null
          whatsapp_business_account_id: string | null
          whatsapp_phone_number_id: string | null
          whatsapp_provider: string | null
          whatsapp_verify_token: string | null
        }
        Insert: {
          created_at?: string
          gemini_api_key?: string | null
          gemini_model?: string | null
          indiamart_crm_key?: string | null
          razorpay_key_id?: string | null
          razorpay_key_secret?: string | null
          razorpay_mode?: string | null
          razorpay_webhook_secret?: string | null
          resend_api_key?: string | null
          sandbox_api_base?: string | null
          sandbox_api_key?: string | null
          sandbox_api_secret?: string | null
          tenant_id: string
          updated_at?: string
          whatsapp_access_token?: string | null
          whatsapp_app_secret?: string | null
          whatsapp_business_account_id?: string | null
          whatsapp_phone_number_id?: string | null
          whatsapp_provider?: string | null
          whatsapp_verify_token?: string | null
        }
        Update: {
          created_at?: string
          gemini_api_key?: string | null
          gemini_model?: string | null
          indiamart_crm_key?: string | null
          razorpay_key_id?: string | null
          razorpay_key_secret?: string | null
          razorpay_mode?: string | null
          razorpay_webhook_secret?: string | null
          resend_api_key?: string | null
          sandbox_api_base?: string | null
          sandbox_api_key?: string | null
          sandbox_api_secret?: string | null
          tenant_id?: string
          updated_at?: string
          whatsapp_access_token?: string | null
          whatsapp_app_secret?: string | null
          whatsapp_business_account_id?: string | null
          whatsapp_phone_number_id?: string | null
          whatsapp_provider?: string | null
          whatsapp_verify_token?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tenant_secrets_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_secrets_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      tenants: {
        Row: {
          address: string | null
          ai_kill_switch: boolean
          attendance_ingest_key: string | null
          auto_suspend_on_overdue: boolean
          books_locked_until: string | null
          contact_name: string | null
          created_at: string
          doc_code: string | null
          email: string
          email_from_address: string | null
          email_from_name: string | null
          email_provider: string
          followup_value_drop: string | null
          gmail_sender_user_id: string | null
          grace_period_days: number
          gstin: string | null
          gstin_verification: Json | null
          gstin_verified_at: string | null
          id: string
          logo_url: string | null
          lut_number: string | null
          lut_valid_upto: string | null
          name: string
          parent_tenant_id: string | null
          phone: string | null
          pin_code: string | null
          remit_account_name: string | null
          remit_account_number: string | null
          remit_bank_name: string | null
          remit_branch: string | null
          remit_ifsc: string | null
          setup_completed_at: string | null
          state: string | null
          state_code: string | null
          tier: string
          updated_at: string
          upi_payee_name: string | null
          upi_vpa: string | null
        }
        Insert: {
          address?: string | null
          ai_kill_switch?: boolean
          attendance_ingest_key?: string | null
          auto_suspend_on_overdue?: boolean
          books_locked_until?: string | null
          contact_name?: string | null
          created_at?: string
          doc_code?: string | null
          email: string
          email_from_address?: string | null
          email_from_name?: string | null
          email_provider?: string
          followup_value_drop?: string | null
          gmail_sender_user_id?: string | null
          grace_period_days?: number
          gstin?: string | null
          gstin_verification?: Json | null
          gstin_verified_at?: string | null
          id?: string
          logo_url?: string | null
          lut_number?: string | null
          lut_valid_upto?: string | null
          name: string
          parent_tenant_id?: string | null
          phone?: string | null
          pin_code?: string | null
          remit_account_name?: string | null
          remit_account_number?: string | null
          remit_bank_name?: string | null
          remit_branch?: string | null
          remit_ifsc?: string | null
          setup_completed_at?: string | null
          state?: string | null
          state_code?: string | null
          tier?: string
          updated_at?: string
          upi_payee_name?: string | null
          upi_vpa?: string | null
        }
        Update: {
          address?: string | null
          ai_kill_switch?: boolean
          attendance_ingest_key?: string | null
          auto_suspend_on_overdue?: boolean
          books_locked_until?: string | null
          contact_name?: string | null
          created_at?: string
          doc_code?: string | null
          email?: string
          email_from_address?: string | null
          email_from_name?: string | null
          email_provider?: string
          followup_value_drop?: string | null
          gmail_sender_user_id?: string | null
          grace_period_days?: number
          gstin?: string | null
          gstin_verification?: Json | null
          gstin_verified_at?: string | null
          id?: string
          logo_url?: string | null
          lut_number?: string | null
          lut_valid_upto?: string | null
          name?: string
          parent_tenant_id?: string | null
          phone?: string | null
          pin_code?: string | null
          remit_account_name?: string | null
          remit_account_number?: string | null
          remit_bank_name?: string | null
          remit_branch?: string | null
          remit_ifsc?: string | null
          setup_completed_at?: string | null
          state?: string | null
          state_code?: string | null
          tier?: string
          updated_at?: string
          upi_payee_name?: string | null
          upi_vpa?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tenants_gmail_sender_user_id_fkey"
            columns: ["gmail_sender_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenants_parent_tenant_id_fkey"
            columns: ["parent_tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenants_parent_tenant_id_fkey"
            columns: ["parent_tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      tracking_links: {
        Row: {
          channel: string
          created_at: string
          created_by: string | null
          destination_path: string
          full_url: string
          id: string
          label: string
          tenant_id: string
          utm_campaign: string
          utm_content: string | null
          utm_medium: string
        }
        Insert: {
          channel: string
          created_at?: string
          created_by?: string | null
          destination_path: string
          full_url: string
          id?: string
          label: string
          tenant_id: string
          utm_campaign: string
          utm_content?: string | null
          utm_medium: string
        }
        Update: {
          channel?: string
          created_at?: string
          created_by?: string | null
          destination_path?: string
          full_url?: string
          id?: string
          label?: string
          tenant_id?: string
          utm_campaign?: string
          utm_content?: string | null
          utm_medium?: string
        }
        Relationships: [
          {
            foreignKeyName: "tracking_links_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tracking_links_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      txn_category_rules: {
        Row: {
          category: string
          created_at: string
          created_by: string | null
          created_from_txn_id: string | null
          direction: string
          hit_count: number
          id: string
          pattern: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          category: string
          created_at?: string
          created_by?: string | null
          created_from_txn_id?: string | null
          direction?: string
          hit_count?: number
          id?: string
          pattern: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          category?: string
          created_at?: string
          created_by?: string | null
          created_from_txn_id?: string | null
          direction?: string
          hit_count?: number
          id?: string
          pattern?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "txn_category_rules_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "txn_category_rules_created_from_txn_id_fkey"
            columns: ["created_from_txn_id"]
            isOneToOne: false
            referencedRelation: "bank_transactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "txn_category_rules_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "txn_category_rules_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      ui_page_scores: {
        Row: {
          id: string
          issues: Json
          path: string
          prev_score: number | null
          samples: number
          score: number
          surface: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          id?: string
          issues?: Json
          path: string
          prev_score?: number | null
          samples?: number
          score: number
          surface: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          id?: string
          issues?: Json
          path?: string
          prev_score?: number | null
          samples?: number
          score?: number
          surface?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ui_page_scores_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ui_page_scores_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      user_google_tokens: {
        Row: {
          access_token: string | null
          created_at: string
          google_email: string | null
          last_error: string | null
          last_synced_at: string | null
          refresh_token: string | null
          scopes: string | null
          sync_token: string | null
          tenant_id: string
          token_expiry: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          access_token?: string | null
          created_at?: string
          google_email?: string | null
          last_error?: string | null
          last_synced_at?: string | null
          refresh_token?: string | null
          scopes?: string | null
          sync_token?: string | null
          tenant_id: string
          token_expiry?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          access_token?: string | null
          created_at?: string
          google_email?: string | null
          last_error?: string | null
          last_synced_at?: string | null
          refresh_token?: string | null
          scopes?: string | null
          sync_token?: string | null
          tenant_id?: string
          token_expiry?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_google_tokens_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_google_tokens_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_google_tokens_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          attendance_checkout_reminder_at: string
          attendance_reminders_enabled: boolean
          avatar_url: string | null
          can_view_deals: boolean
          color: string | null
          created_at: string
          email: string
          employee_id: string | null
          full_name: string | null
          gets_new_leads: boolean
          id: string
          initials: string | null
          is_active: boolean
          last_lead_assigned_at: string | null
          manager_id: string | null
          phone: string | null
          role: Database["public"]["Enums"]["user_role"]
          tenant_id: string
        }
        Insert: {
          attendance_checkout_reminder_at?: string
          attendance_reminders_enabled?: boolean
          avatar_url?: string | null
          can_view_deals?: boolean
          color?: string | null
          created_at?: string
          email: string
          employee_id?: string | null
          full_name?: string | null
          gets_new_leads?: boolean
          id: string
          initials?: string | null
          is_active?: boolean
          last_lead_assigned_at?: string | null
          manager_id?: string | null
          phone?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          tenant_id: string
        }
        Update: {
          attendance_checkout_reminder_at?: string
          attendance_reminders_enabled?: boolean
          avatar_url?: string | null
          can_view_deals?: boolean
          color?: string | null
          created_at?: string
          email?: string
          employee_id?: string | null
          full_name?: string | null
          gets_new_leads?: boolean
          id?: string
          initials?: string | null
          is_active?: boolean
          last_lead_assigned_at?: string | null
          manager_id?: string | null
          phone?: string | null
          role?: Database["public"]["Enums"]["user_role"]
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "users_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "users_manager_id_fkey"
            columns: ["manager_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "users_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "users_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      ux_analysis_runs: {
        Row: {
          events_seen: number
          id: number
          insights: number
          mode: string
          ran_at: string
          tenant_id: string | null
        }
        Insert: {
          events_seen?: number
          id?: never
          insights?: number
          mode: string
          ran_at?: string
          tenant_id?: string | null
        }
        Update: {
          events_seen?: number
          id?: never
          insights?: number
          mode?: string
          ran_at?: string
          tenant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ux_analysis_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ux_analysis_runs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      ux_events: {
        Row: {
          created_at: string
          detail: string | null
          id: number
          kind: string
          metrics: Json | null
          ms: number | null
          path: string
          session_id: string
          surface: string
          target: string | null
          tenant_id: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          detail?: string | null
          id?: never
          kind: string
          metrics?: Json | null
          ms?: number | null
          path: string
          session_id: string
          surface: string
          target?: string | null
          tenant_id?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          detail?: string | null
          id?: never
          kind?: string
          metrics?: Json | null
          ms?: number | null
          path?: string
          session_id?: string
          surface?: string
          target?: string | null
          tenant_id?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ux_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ux_events_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      ux_insights: {
        Row: {
          agent: string
          card_ref: string | null
          category: string
          created_at: string
          done_at: string | null
          evidence: string
          fix: string
          id: string
          path: string
          problem: string
          sessions: number
          severity: string
          signature: string
          status: string
          surface: string
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          agent?: string
          card_ref?: string | null
          category: string
          created_at?: string
          done_at?: string | null
          evidence: string
          fix: string
          id?: string
          path: string
          problem: string
          sessions?: number
          severity: string
          signature: string
          status?: string
          surface: string
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          agent?: string
          card_ref?: string | null
          category?: string
          created_at?: string
          done_at?: string | null
          evidence?: string
          fix?: string
          id?: string
          path?: string
          problem?: string
          sessions?: number
          severity?: string
          signature?: string
          status?: string
          surface?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ux_insights_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ux_insights_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      vault_access_log: {
        Row: {
          action: string
          created_at: string
          credential_id: string | null
          customer_id: string | null
          id: number
          ip_address: unknown
          tenant_id: string
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          action: string
          created_at?: string
          credential_id?: string | null
          customer_id?: string | null
          id?: number
          ip_address?: unknown
          tenant_id: string
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          credential_id?: string | null
          customer_id?: string | null
          id?: number
          ip_address?: unknown
          tenant_id?: string
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "vault_access_log_credential_id_fkey"
            columns: ["credential_id"]
            isOneToOne: false
            referencedRelation: "vault_passwords"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vault_access_log_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vault_access_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vault_access_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vault_access_log_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      vault_passwords: {
        Row: {
          category: Database["public"]["Enums"]["vault_category"]
          created_at: string
          created_by: string | null
          customer_id: string | null
          id: string
          last_rotated_at: string | null
          notes_ciphertext: string | null
          password_ciphertext: string | null
          password_fingerprint: string | null
          tenant_id: string
          title: string
          updated_at: string
          url: string | null
          username_ciphertext: string | null
        }
        Insert: {
          category?: Database["public"]["Enums"]["vault_category"]
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          id?: string
          last_rotated_at?: string | null
          notes_ciphertext?: string | null
          password_ciphertext?: string | null
          password_fingerprint?: string | null
          tenant_id: string
          title: string
          updated_at?: string
          url?: string | null
          username_ciphertext?: string | null
        }
        Update: {
          category?: Database["public"]["Enums"]["vault_category"]
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          id?: string
          last_rotated_at?: string | null
          notes_ciphertext?: string | null
          password_ciphertext?: string | null
          password_fingerprint?: string | null
          tenant_id?: string
          title?: string
          updated_at?: string
          url?: string | null
          username_ciphertext?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "vault_passwords_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vault_passwords_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vault_passwords_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vault_passwords_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_run_items: {
        Row: {
          amount: number
          doc_id: string
          doc_ref: string | null
          id: string
          run_id: string
          source: string
          tenant_id: string
          vendor_id: string | null
          vendor_name: string
        }
        Insert: {
          amount?: number
          doc_id?: string
          doc_ref?: string | null
          id?: string
          run_id?: string
          source?: string
          tenant_id?: string
          vendor_id?: string | null
          vendor_name?: string
        }
        Update: {
          amount?: number
          doc_id?: string
          doc_ref?: string | null
          id?: string
          run_id?: string
          source?: string
          tenant_id?: string
          vendor_id?: string | null
          vendor_name?: string
        }
        Relationships: []
      }
      payment_runs: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          bank_account_id: string
          cancelled_at: string | null
          cancelled_by: string | null
          created_at: string
          created_by: string
          id: string
          note: string | null
          paid_at: string | null
          paid_by: string | null
          paid_on: string | null
          pay_on: string
          run_no: string
          status: string
          tenant_id: string
          total: number
          updated_at: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          bank_account_id?: string
          cancelled_at?: string | null
          cancelled_by?: string | null
          created_at?: string
          created_by?: string
          id?: string
          note?: string | null
          paid_at?: string | null
          paid_by?: string | null
          paid_on?: string | null
          pay_on?: string
          run_no?: string
          status?: string
          tenant_id?: string
          total?: number
          updated_at?: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          bank_account_id?: string
          cancelled_at?: string | null
          cancelled_by?: string | null
          created_at?: string
          created_by?: string
          id?: string
          note?: string | null
          paid_at?: string | null
          paid_by?: string | null
          paid_on?: string | null
          pay_on?: string
          run_no?: string
          status?: string
          tenant_id?: string
          total?: number
          updated_at?: string
        }
        Relationships: []
      }
      vendor_bills: {
        Row: {
          attachment_url: string | null
          bill_date: string
          bill_no: string | null
          category: string
          cgst: number
          created_at: string
          currency: string
          due_date: string | null
          fx_rate: number
          id: string
          igst: number
          line_items: Json
          notes: string | null
          paid_amount: number
          sgst: number
          source_tenant_invoice_id: string | null
          status: string
          subtotal: number
          tenant_id: string
          total: number
          updated_at: string
          vendor_gstin: string | null
          vendor_id: string | null
          vendor_name: string
        }
        Insert: {
          attachment_url?: string | null
          bill_date: string
          bill_no?: string | null
          category?: string
          cgst?: number
          created_at?: string
          currency?: string
          due_date?: string | null
          fx_rate?: number
          id: string
          igst?: number
          line_items?: Json
          notes?: string | null
          paid_amount?: number
          sgst?: number
          source_tenant_invoice_id?: string | null
          status?: string
          subtotal?: number
          tenant_id: string
          total: number
          updated_at?: string
          vendor_gstin?: string | null
          vendor_id?: string | null
          vendor_name: string
        }
        Update: {
          attachment_url?: string | null
          bill_date?: string
          bill_no?: string | null
          category?: string
          cgst?: number
          created_at?: string
          currency?: string
          due_date?: string | null
          fx_rate?: number
          id?: string
          igst?: number
          line_items?: Json
          notes?: string | null
          paid_amount?: number
          sgst?: number
          source_tenant_invoice_id?: string | null
          status?: string
          subtotal?: number
          tenant_id?: string
          total?: number
          updated_at?: string
          vendor_gstin?: string | null
          vendor_id?: string | null
          vendor_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "vendor_bills_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vendor_bills_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vendor_bills_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      vendors: {
        Row: {
          address: string | null
          bank_account_name: string | null
          bank_account_no: string | null
          bank_ifsc: string | null
          city: string | null
          contact_email: string | null
          contact_name: string | null
          contact_phone: string | null
          created_at: string
          default_category: string | null
          gstin: string | null
          id: string
          msme_category: string | null
          name: string
          notes: string | null
          pan: string | null
          pincode: string | null
          state: string | null
          tenant_id: string
          udyam: string | null
          updated_at: string
          upi_id: string | null
        }
        Insert: {
          address?: string | null
          bank_account_name?: string | null
          bank_account_no?: string | null
          bank_ifsc?: string | null
          city?: string | null
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string
          default_category?: string | null
          gstin?: string | null
          id?: string
          msme_category?: string | null
          name: string
          notes?: string | null
          pan?: string | null
          pincode?: string | null
          state?: string | null
          tenant_id: string
          udyam?: string | null
          updated_at?: string
          upi_id?: string | null
        }
        Update: {
          address?: string | null
          bank_account_name?: string | null
          bank_account_no?: string | null
          bank_ifsc?: string | null
          city?: string | null
          contact_email?: string | null
          contact_name?: string | null
          contact_phone?: string | null
          created_at?: string
          default_category?: string | null
          gstin?: string | null
          id?: string
          msme_category?: string | null
          name?: string
          notes?: string | null
          pan?: string | null
          pincode?: string | null
          state?: string | null
          tenant_id?: string
          udyam?: string | null
          updated_at?: string
          upi_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "vendors_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vendors_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_broadcasts: {
        Row: {
          audience: Json
          created_at: string
          created_by: string | null
          failed_count: number
          id: string
          recipients_count: number
          sent_count: number
          skipped_count: number
          status: string
          template_id: string | null
          template_name: string
          tenant_id: string
        }
        Insert: {
          audience?: Json
          created_at?: string
          created_by?: string | null
          failed_count?: number
          id?: string
          recipients_count?: number
          sent_count?: number
          skipped_count?: number
          status?: string
          template_id?: string | null
          template_name: string
          tenant_id: string
        }
        Update: {
          audience?: Json
          created_at?: string
          created_by?: string | null
          failed_count?: number
          id?: string
          recipients_count?: number
          sent_count?: number
          skipped_count?: number
          status?: string
          template_id?: string | null
          template_name?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_broadcasts_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "whatsapp_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_broadcasts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_broadcasts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_messages: {
        Row: {
          contact_phone: string
          created_at: string
          direction: string
          error_code: string | null
          error_message: string | null
          id: string
          media_filename: string | null
          media_id: string | null
          media_mime: string | null
          meta_timestamp: string | null
          related_customer_id: string | null
          related_lead_id: string | null
          related_quote_id: string | null
          status: string
          template_lang: string | null
          template_name: string | null
          template_params: Json | null
          tenant_id: string
          text_body: string | null
          transcript: string | null
          transcript_lang: string | null
          type: string
          wamid: string | null
        }
        Insert: {
          contact_phone: string
          created_at?: string
          direction: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          media_filename?: string | null
          media_id?: string | null
          media_mime?: string | null
          meta_timestamp?: string | null
          related_customer_id?: string | null
          related_lead_id?: string | null
          related_quote_id?: string | null
          status?: string
          template_lang?: string | null
          template_name?: string | null
          template_params?: Json | null
          tenant_id: string
          text_body?: string | null
          transcript?: string | null
          transcript_lang?: string | null
          type: string
          wamid?: string | null
        }
        Update: {
          contact_phone?: string
          created_at?: string
          direction?: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          media_filename?: string | null
          media_id?: string | null
          media_mime?: string | null
          meta_timestamp?: string | null
          related_customer_id?: string | null
          related_lead_id?: string | null
          related_quote_id?: string | null
          status?: string
          template_lang?: string | null
          template_name?: string | null
          template_params?: Json | null
          tenant_id?: string
          text_body?: string | null
          transcript?: string | null
          transcript_lang?: string | null
          type?: string
          wamid?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_messages_related_customer_id_fkey"
            columns: ["related_customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_messages_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_messages_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_opt_outs: {
        Row: {
          created_at: string
          phone: string
          reason: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          phone: string
          reason?: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          phone?: string
          reason?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_opt_outs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_opt_outs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_reminder_log: {
        Row: {
          created_at: string
          delivered_at: string | null
          error_message: string | null
          failed_at: string | null
          id: string
          kind: string
          message_id: string | null
          phone: string | null
          read_at: string | null
          sent_at: string | null
          skip_reason: string | null
          status: string
          step: string
          subject_id: string
          subject_type: string
          template_name: string | null
          tenant_id: string
          wamid: string | null
        }
        Insert: {
          created_at?: string
          delivered_at?: string | null
          error_message?: string | null
          failed_at?: string | null
          id?: string
          kind: string
          message_id?: string | null
          phone?: string | null
          read_at?: string | null
          sent_at?: string | null
          skip_reason?: string | null
          status: string
          step: string
          subject_id: string
          subject_type: string
          template_name?: string | null
          tenant_id: string
          wamid?: string | null
        }
        Update: {
          created_at?: string
          delivered_at?: string | null
          error_message?: string | null
          failed_at?: string | null
          id?: string
          kind?: string
          message_id?: string | null
          phone?: string | null
          read_at?: string | null
          sent_at?: string | null
          skip_reason?: string | null
          status?: string
          step?: string
          subject_id?: string
          subject_type?: string
          template_name?: string | null
          tenant_id?: string
          wamid?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_reminder_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_reminder_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_reminder_settings: {
        Row: {
          enabled: boolean
          tenant_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          enabled?: boolean
          tenant_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          enabled?: boolean
          tenant_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_reminder_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_reminder_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_reminder_templates: {
        Row: {
          created_at: string
          enabled: boolean
          id: string
          kind: string
          language: string
          param_map: Json
          template_name: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          id?: string
          kind: string
          language?: string
          param_map?: Json
          template_name: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          id?: string
          kind?: string
          language?: string
          param_map?: Json
          template_name?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_reminder_templates_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_reminder_templates_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_templates: {
        Row: {
          body: string
          category: string
          created_at: string
          created_by: string | null
          id: string
          language: string
          meta_id: string | null
          name: string
          notes: string | null
          param_map: Json
          status: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          body: string
          category?: string
          created_at?: string
          created_by?: string | null
          id?: string
          language?: string
          meta_id?: string | null
          name: string
          notes?: string | null
          param_map?: Json
          status?: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          body?: string
          category?: string
          created_at?: string
          created_by?: string | null
          id?: string
          language?: string
          meta_id?: string | null
          name?: string
          notes?: string | null
          param_map?: Json
          status?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_templates_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_templates_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      purchase_order_summary: {
        Row: {
          allocated_total: number | null
          allocation_count: number | null
          closed_at: string | null
          customer_id: string | null
          customer_name: string | null
          expected_cost: number | null
          placed_at: string | null
          plan: string | null
          provisioned_at: string | null
          purchase_order_id: string | null
          seats: number | null
          status: string | null
          subscription_id: string | null
          tenant_id: string | null
          term_months: number | null
          unit_cost_pm: number | null
          variance_amount: number | null
          vendor: Database["public"]["Enums"]["vendor"] | null
        }
        Relationships: [
          {
            foreignKeyName: "purchase_orders_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
      v_tenant_with_parent: {
        Row: {
          id: string | null
          name: string | null
          parent_gstin: string | null
          parent_name: string | null
          parent_tenant_id: string | null
          parent_tier: string | null
          tier: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tenants_parent_tenant_id_fkey"
            columns: ["parent_tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenants_parent_tenant_id_fkey"
            columns: ["parent_tenant_id"]
            isOneToOne: false
            referencedRelation: "v_tenant_with_parent"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      _employee_advance_cash_leg: {
        Args: {
          p_account: string
          p_adv: string
          p_credit: number
          p_date: string
          p_debit: number
          p_tenant: string
          p_text: string
        }
        Returns: string
      }
      academy_can_manage: { Args: never; Returns: boolean }
      academy_load_default_program: { Args: never; Returns: string }
      academy_load_default_skills: { Args: never; Returns: number }
      academy_my_apprentice_id: { Args: never; Returns: string }
      academy_my_tenant_id: { Args: never; Returns: string }
      academy_review_task: {
        Args: {
          p_feedback: string
          p_marks: number
          p_result: string
          p_task_id: string
        }
        Returns: undefined
      }
      academy_staff_sees: {
        Args: { p_apprentice_id: string }
        Returns: boolean
      }
      academy_start_task: { Args: { p_task_id: string }; Returns: undefined }
      academy_submit_task: {
        Args: {
          p_github: string
          p_link: string
          p_note: string
          p_task_id: string
        }
        Returns: number
      }
      accept_project_quote: { Args: { p_project_id: string }; Returns: string }
      accept_quote: { Args: { p_quote_id: string }; Returns: Json }
      ad_channel_guess: { Args: { p_text: string }; Returns: string }
      add_project_receipt_milestone: {
        Args: { p_amount: number; p_label: string; p_project_id: string }
        Returns: string
      }
      add_reimbursement: {
        Args: {
          p_amount: number
          p_category: string
          p_employee_id?: string
          p_gst: number
          p_incurred_on: string
          p_paid_via: string
          p_person: string
          p_purpose: string
          p_receipt_path?: string
        }
        Returns: string
      }
      approve_expense_claim: {
        Args: { p_claim_id: string }
        Returns: undefined
      }
      auto_backup_if_stale: { Args: never; Returns: Json }
      backup_all_tenants: { Args: { p_label?: string }; Returns: Json }
      backup_tenant: {
        Args: { p_label?: string; p_tenant: string }
        Returns: Json
      }
      bank_account_current_balance: {
        Args: { p_account_id: string }
        Returns: number
      }
      book_bank_advance: {
        Args: {
          p_counterparty: string
          p_kind?: string
          p_notes?: string
          p_txn_id: string
        }
        Returns: undefined
      }
      book_bank_credit: {
        Args: {
          p_kind: string
          p_label: string
          p_notes?: string
          p_txn_id: string
        }
        Returns: undefined
      }
      book_bank_txn_as_expense: {
        Args: {
          p_category: string
          p_gst: number
          p_notes?: string
          p_txn_id: string
          p_vendor: string
        }
        Returns: string
      }
      book_bank_txn_as_prepaid: {
        Args: {
          p_category?: string
          p_notes?: string
          p_txn_id: string
          p_vendor_name: string
        }
        Returns: string
      }
      book_bank_txn_as_referral_commission: {
        Args: { p_commission_id: string; p_txn_id: string }
        Returns: Json
      }
      book_bank_txn_as_statutory: {
        Args: {
          p_challan_no?: string
          p_kind: string
          p_notes?: string
          p_period?: string
          p_txn_id: string
        }
        Returns: undefined
      }
      book_bank_txn_as_tax: {
        Args: {
          p_fy?: string
          p_interest?: number
          p_kind: string
          p_late_fee?: number
          p_notes?: string
          p_period?: string
          p_txn_id: string
        }
        Returns: string
      }
      book_bank_txn_as_vendor_bill: {
        Args: { p_bill_id: string; p_method?: string; p_txn_id: string }
        Returns: Json
      }
      can_see_record: { Args: { p_owner: string }; Returns: boolean }
      compute_advance_adjustment: {
        Args: { p_quote_id: string }
        Returns: {
          advances: Json
          first_at: string
          total_paid: number
        }[]
      }
      consume_prepaid_advance: {
        Args: {
          p_advance_id: string
          p_amount: number
          p_attachment?: string
          p_date?: string
          p_gst?: number
          p_note?: string
        }
        Returns: number
      }
      consume_prepaid_fifo: {
        Args: {
          p_amount: number
          p_attachment?: string
          p_bill_no?: string
          p_cgst?: number
          p_date?: string
          p_gst?: number
          p_igst?: number
          p_note?: string
          p_sgst?: number
          p_tds_amount?: number
          p_tds_section?: string
          p_vendor_id?: string
          p_vendor_name: string
        }
        Returns: number
      }
      convert_inbound_email_to_lead: { Args: { p_id: string }; Returns: string }
      create_direct_invoice: {
        Args: {
          p_customer_id: string
          p_line_items: Json
          p_notes?: string
          p_recurring?: boolean
        }
        Returns: {
          invoice_id: string
          net_payable: number
          quote_id: string
          tax_rate: number
        }[]
      }
      create_project_direct_invoice: {
        Args: {
          p_customer_id: string
          p_customer_name: string
          p_description: string
          p_gst_rate: number
          p_inter_state: boolean
          p_line_items: Json
          p_title: string
        }
        Returns: {
          invoice_id: string
          project_id: string
        }[]
      }
      create_project_quote: {
        Args: {
          p_customer_id: string
          p_customer_name: string
          p_description: string
          p_gst_rate: number
          p_inter_state: boolean
          p_line_items: Json
          p_milestones: Json
          p_title: string
        }
        Returns: string
      }
      create_project_quote_from_lead: {
        Args: {
          p_description: string
          p_gst_rate: number
          p_inter_state: boolean
          p_lead_id: string
          p_line_items: Json
          p_milestones: Json
          p_title: string
        }
        Returns: string
      }
      create_project_sale: {
        Args: {
          p_customer_id: string
          p_customer_name: string
          p_description: string
          p_gst_rate: number
          p_inter_state: boolean
          p_milestones: Json
          p_taxable: number
          p_title: string
        }
        Returns: string
      }
      create_site_promo: {
        Args: {
          p_applies_to_tier: string
          p_badge_text: string
          p_banner_style: string
          p_created_by: string
          p_discount_type: string
          p_discount_value: number
          p_headline: string
          p_max_seats: number
          p_min_seats: number
          p_subheadline: string
          p_tenant_id: string
          p_valid_until: string
        }
        Returns: string
      }
      create_tenant_backup: { Args: { p_label?: string }; Returns: Json }
      current_customer_id: { Args: never; Returns: string }
      current_tenant_id: { Args: never; Returns: string }
      current_user_has_role: { Args: { p_roles: string[] }; Returns: boolean }
      current_user_is_owner: { Args: never; Returns: boolean }
      customer_name_key: { Args: { p_name: string }; Returns: string }
      customer_names_agree: { Args: { a: string; b: string }; Returns: boolean }
      default_doc_prefix: { Args: { p_doc_type: string }; Returns: string }
      delete_bank_account: {
        Args: { p_account_id: string }
        Returns: undefined
      }
      delete_business_loan: { Args: { p_loan_id: string }; Returns: undefined }
      delete_claim_public: {
        Args: {
          p_claim_id: string
          p_employee_id: string
          p_pin: string
          p_tenant_id: string
        }
        Returns: undefined
      }
      delete_customer: { Args: { p_customer_id: string }; Returns: Json }
      delete_employee_advance: {
        Args: { p_advance_id: string; p_delete_expenses?: boolean }
        Returns: Json
      }
      delete_employee_loan: { Args: { p_loan_id: string }; Returns: undefined }
      delete_expense_claim: { Args: { p_claim_id: string }; Returns: undefined }
      delete_payment: { Args: { p_payment_id: string }; Returns: Json }
      delete_project_invoice: {
        Args: { p_invoice_id: string }
        Returns: undefined
      }
      delete_project_sale: {
        Args: { p_project_id: string }
        Returns: undefined
      }
      delete_reimbursement: { Args: { p_id: string }; Returns: undefined }
      delete_salary_payment: {
        Args: { p_salary_id: string }
        Returns: undefined
      }
      delete_subscription: {
        Args: { p_subscription_id: string }
        Returns: Json
      }
      delete_subscription_invoice: {
        Args: { p_invoice_id: string }
        Returns: undefined
      }
      delete_tenant_backup: { Args: { p_id: string }; Returns: undefined }
      disburse_employee_loan: {
        Args: {
          p_bank_account_id: string
          p_disbursed_on: string
          p_employee_name: string
          p_kind?: string
          p_notes?: string
          p_principal: number
        }
        Returns: string
      }
      edit_claim_public: {
        Args: {
          p_amount: number
          p_category: string
          p_claim_id: string
          p_employee_id: string
          p_pin: string
          p_purpose: string
          p_spent_on: string
          p_tenant_id: string
        }
        Returns: undefined
      }
      edit_employee_loan: {
        Args: {
          p_bank_account_id: string
          p_disbursed_on: string
          p_employee_name: string
          p_kind: string
          p_loan_id: string
          p_notes?: string
          p_principal: number
        }
        Returns: undefined
      }
      edit_expense_claim: {
        Args: {
          p_amount: number
          p_category: string
          p_claim_id: string
          p_purpose: string
          p_spent_on: string
        }
        Returns: undefined
      }
      export_snapshots_for_offsite: { Args: { p_since: string }; Returns: Json }
      export_tenant_snapshot_for_offsite: {
        Args: { p_since: string; p_tenant: string }
        Returns: Json
      }
      find_lead_duplicates: {
        Args: {
          p_company?: string
          p_email?: string
          p_exclude_id?: string
          p_gstin?: string
          p_phone?: string
        }
        Returns: {
          company: string
          contact_name: string
          created_at: string
          id: string
          is_junk: boolean
          matched_on: string[]
          owner_id: string
          owner_name: string
          stage: string
        }[]
      }
      format_document_number: {
        Args: { p_fiscal_year: string; p_number: number; p_prefix: string }
        Returns: string
      }
      generate_invoice: {
        Args: { p_quote_id: string }
        Returns: {
          invoice_id: string
          net_payable: number
          total_advances: number
        }[]
      }
      get_active_site_promo: {
        Args: { p_seats?: number; p_tenant_id: string; p_tier_id?: string }
        Returns: {
          applies_to_tier: string | null
          applies_to_vendor: string | null
          badge_text: string | null
          banner_style: string
          created_at: string
          created_by: string | null
          discount_type: string
          discount_value: number
          headline: string
          id: string
          is_active: boolean
          max_seats: number | null
          min_seats: number
          subheadline: string | null
          tenant_id: string
          updated_at: string
          valid_from: string
          valid_until: string | null
        }
        SetofOptions: {
          from: "*"
          to: "site_promos"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      get_my_tenant_with_parent: {
        Args: never
        Returns: {
          id: string
          name: string
          parent_gstin: string
          parent_name: string
          parent_tenant_id: string
          parent_tier: string
          tier: string
        }[]
      }
      get_partner_catalog: {
        Args: never
        Returns: {
          already_synced: boolean
          hsn: string
          id: string
          is_active: boolean
          kind: string
          msrp: number
          name: string
          partner_price: number
          prices: Json
          tenant_id: string
          vendor: string
        }[]
      }
      get_partner_metrics: {
        Args: never
        Returns: {
          active_subscriptions: number
          invoiced_this_month: number
          last_invoice_date: string
          mrr: number
          paid_this_month: number
          renewal_revenue_30d: number
          renewals_due_30d: number
          tenant_gstin: string
          tenant_id: string
          tenant_name: string
          total_seats_sold: number
        }[]
      }
      get_subordinate_user_ids: {
        Args: { p_user_id: string }
        Returns: string[]
      }
      get_tenant_backup: { Args: { p_id: string }; Returns: Json }
      give_employee_advance: {
        Args: {
          p_account?: string
          p_amount: number
          p_date?: string
          p_method?: string
          p_name: string
          p_note?: string
        }
        Returns: string
      }
      guard_backup_owner_only: { Args: never; Returns: undefined }
      hierarchy_sees_all: { Args: never; Returns: boolean }
      import_indiamart_lead: {
        Args: {
          p_company: string
          p_contact_name: string
          p_email: string
          p_lead_id: string
          p_notes: string
          p_phone: string
          p_query_id: string
          p_query_time: string
          p_query_type: string
          p_state: string
          p_tenant_id: string
        }
        Returns: string
      }
      indian_fiscal_year: { Args: { p_date?: string }; Returns: string }
      invoice_party_snapshot: {
        Args: { p_customer: string; p_tenant: string }
        Returns: {
          billing_address: string
          customer_country: string
          customer_gstin: string
          pos_state_code: string
          seller_gstin: string
          seller_state_code: string
        }[]
      }
      issue_credit_note: {
        Args: {
          p_gross_amount: number
          p_invoice_id: string
          p_notes?: string
          p_reason?: string
          p_reason_code?: string
        }
        Returns: Json
      }
      issue_debit_note: {
        Args: {
          p_gross_amount: number
          p_invoice_id: string
          p_notes?: string
          p_reason?: string
          p_reason_code?: string
        }
        Returns: Json
      }
      ist_today: { Args: never; Returns: string }
      lead_counts: { Args: { p_filters?: Json }; Returns: Json }
      lead_looks_like_junk: {
        Args: {
          p_company: string
          p_contact_email: string
          p_contact_name: string
          p_contact_phone: string
        }
        Returns: boolean
      }
      lead_norm_company: { Args: { c: string }; Returns: string }
      lead_norm_email: { Args: { e: string }; Returns: string }
      lead_norm_gstin: { Args: { g: string }; Returns: string }
      lead_norm_phone: { Args: { p: string }; Returns: string }
      list_leads: {
        Args: { p_cursor?: Json; p_filters?: Json; p_limit?: number }
        Returns: Json
      }
      list_stranded_auth_users: {
        Args: never
        Returns: {
          created_at: string
          email: string
          full_name: string
          last_sign_in_at: string
        }[]
      }
      list_tenant_backups: {
        Args: never
        Returns: {
          bytes: number
          created_at: string
          id: string
          kind: string
          label: string
          table_count: number
        }[]
      }
      list_whatsapp_threads: {
        Args: { p_cursor?: Json; p_limit?: number }
        Returns: Json
      }
      log_activity: {
        Args: {
          p_action: string
          p_entity?: string
          p_entity_id?: string
          p_label?: string
        }
        Returns: undefined
      }
      log_lead_activity: {
        Args: { p_detail?: string; p_kind: string; p_lead_id: string }
        Returns: string
      }
      mark_attendance: {
        Args: { p_employee_id: string; p_ip?: string; p_pin: string }
        Returns: string
      }
      mark_self_attendance: { Args: never; Returns: string }
      match_existing_customer: {
        Args: {
          p_company: string
          p_email: string
          p_gstin: string
          p_tenant: string
        }
        Returns: string
      }
      merge_leads: {
        Args: { p_duplicate_id: string; p_primary_id: string }
        Returns: undefined
      }
      merge_stranded_user_into_tenant: {
        Args: {
          p_email: string
          p_role?: Database["public"]["Enums"]["user_role"]
          p_tenant_id: string
        }
        Returns: Json
      }
      msme_payables_aging: {
        Args: { p_as_of?: string }
        Returns: {
          amount_due: number
          bill_date: string
          bill_ref: string
          days_outstanding: number
          deadline: string
          doc_id: string
          msme_category: string
          over_limit: boolean
          source: string
          udyam: string
          vendor_id: string
          vendor_name: string
        }[]
      }
      my_attendance_history: {
        Args: { p_days?: number }
        Returns: {
          check_in: string
          check_out: string
          source: string
          work_date: string
        }[]
      }
      my_attendance_today: { Args: never; Returns: Json }
      nav_badges: { Args: { p_approval_tiers?: string[] }; Returns: Json }
      next_customer_number: { Args: { p_tenant: string }; Returns: string }
      next_document_number: {
        Args: { p_doc_type: string; p_on?: string; p_tenant_id?: string }
        Returns: string
      }
      pay_referral_commission: {
        Args: {
          p_bank_account_id: string
          p_commission_id: string
          p_method?: string
          p_paid_on?: string
        }
        Returns: undefined
      }
      pay_salary: {
        Args: {
          p_advance_loan_id: string
          p_advance_recovered: number
          p_bank_account_id: string
          p_employee_id: string
          p_esi: number
          p_esi_employer?: number
          p_gross: number
          p_incentive?: number
          p_lop_amount: number
          p_lop_days: number
          p_notes?: string
          p_other: number
          p_pay_date: string
          p_period: string
          p_pf: number
          p_pf_employer?: number
          p_pf_wage?: number
          p_tds: number
        }
        Returns: string
      }
      pay_statutory_dues: {
        Args: {
          p_amount: number
          p_bank_account_id: string
          p_challan_no?: string
          p_kind: string
          p_notes?: string
          p_paid_on: string
          p_period?: string
        }
        Returns: undefined
      }
      approve_payment_run: { Args: { p_run_id: string }; Returns: undefined }
      cancel_payment_run: { Args: { p_run_id: string }; Returns: undefined }
      create_payment_run: {
        Args: {
          p_bank_account_id: string
          p_items: Json
          p_note?: string
          p_pay_on?: string
        }
        Returns: string
      }
      mark_payment_run_paid: {
        Args: { p_paid_on?: string; p_run_id: string }
        Returns: undefined
      }
      pay_vendor_bill: {
        Args: {
          p_amount: number
          p_bank_account_id: string
          p_bill_id: string
          p_method?: string
          p_paid_on: string
        }
        Returns: undefined
      }
      plan_key: { Args: { p_name: string }; Returns: string }
      portal_customer_exists: { Args: { p_email: string }; Returns: boolean }
      portal_ensure_customer_link: { Args: never; Returns: string }
      portal_list_products: {
        Args: never
        Returns: {
          hsn: string
          id: string
          name: string
          price_per_seat_month: number
          vendor: string
        }[]
      }
      portal_request_quote: {
        Args: { p_item_id: string; p_note?: string; p_seats: number }
        Returns: string
      }
      portal_touch_login: { Args: never; Returns: undefined }
      purge_ux_events: { Args: never; Returns: number }
      raise_project_milestone_invoice: {
        Args: { p_milestone_id: string }
        Returns: string
      }
      raise_subscription_billing: {
        Args: { p_billing_id: string }
        Returns: {
          already_raised: boolean
          gross: number
          invoice_id: string
        }[]
      }
      rate_limit_hit: {
        Args: { p_key: string; p_limit: number; p_window_ms: number }
        Returns: {
          allowed: boolean
          hits: number
          retry_after_sec: number
        }[]
      }
      reconcile_bank_txn: {
        Args: {
          p_match_confidence: string
          p_matched_to_id: string
          p_matched_to_type: string
          p_txn_id: string
        }
        Returns: {
          balance_after: number | null
          bank_account_id: string
          category: string | null
          category_confidence: number | null
          category_source: string | null
          created_at: string
          credit: number
          debit: number
          description: string
          id: string
          imported_at: string
          match_confidence: string | null
          matched_at: string | null
          matched_by: string | null
          matched_to_id: string | null
          matched_to_type: string | null
          reference: string | null
          source: string
          tenant_id: string
          txn_date: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "bank_transactions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      reconcile_expenses_to_bank_txn: {
        Args: { p_bank_txn_id: string; p_expense_ids: string[] }
        Returns: undefined
      }
      reconcile_salaries_to_bank_txn: {
        Args: { p_bank_txn_id: string; p_salary_ids: string[] }
        Returns: undefined
      }
      reconcile_salary_advance_split: {
        Args: {
          p_advance_amount: number
          p_employee_name: string
          p_notes?: string
          p_salary_id: string
          p_txn_id: string
        }
        Returns: undefined
      }
      record_account_transfer: {
        Args: {
          p_amount: number
          p_from_account: string
          p_note?: string
          p_to_account: string
          p_txn_date: string
        }
        Returns: undefined
      }
      record_attendance_consent: { Args: never; Returns: undefined }
      record_business_loan: {
        Args: {
          p_deposit_account: string
          p_disbursed_on: string
          p_emi_amount: number
          p_interest_rate: number
          p_lender: string
          p_principal: number
          p_purpose: string
          p_tenure_months: number
        }
        Returns: string
      }
      record_emi_payment: {
        Args: {
          p_amount: number
          p_bank_account_id: string
          p_interest: number
          p_notes?: string
          p_paid_on: string
          p_purchase_id: string
        }
        Returns: undefined
      }
      record_emi_purchase: {
        Args: {
          p_category: string
          p_down_account: string
          p_down_payment: number
          p_emi_amount: number
          p_emi_count: number
          p_lender?: string
          p_name: string
          p_notes?: string
          p_purchased_on: string
          p_total_cost: number
        }
        Returns: string
      }
      record_employee_loan_repayment: {
        Args: {
          p_amount: number
          p_bank_account_id?: string
          p_loan_id: string
          p_method: string
          p_notes?: string
          p_repaid_on: string
        }
        Returns: undefined
      }
      record_loan_emi: {
        Args: {
          p_amount: number
          p_bank_account_id: string
          p_interest: number
          p_loan_id: string
          p_notes?: string
          p_paid_on: string
        }
        Returns: undefined
      }
      record_payment: {
        Args: {
          p_amount: number
          p_method: string
          p_notes?: string
          p_quote_id: string
          p_reference: string
        }
        Returns: Json
      }
      record_payment_with_tds: {
        Args: {
          p_amount: number
          p_customer_tan?: string
          p_fiscal_year?: string
          p_invoice_id?: string
          p_method: string
          p_notes?: string
          p_quote_id: string
          p_reference: string
          p_tds_amount?: number
          p_tds_gross?: number
          p_tds_net_paid?: number
          p_tds_rate_pct?: number
          p_tds_section?: string
        }
        Returns: Json
      }
      record_project_payment: {
        Args: {
          p_amount: number
          p_bank_txn_id?: string
          p_method: string
          p_milestone_id: string
          p_received_at: string
          p_reference: string
        }
        Returns: string
      }
      record_project_receipt_with_tds: {
        Args: {
          p_bank_txn_id: string
          p_milestone_id: string
          p_net: number
          p_raise_invoice?: boolean
          p_rate_pct: number
          p_received_at: string
          p_reference: string
          p_section: string
          p_tds: number
          p_tds_base: number
        }
        Returns: Json
      }
      redeem_coupon: {
        Args: {
          p_code: string
          p_email?: string
          p_gross_amount: number
          p_lead_id?: string
          p_name?: string
          p_quote_id?: string
          p_seats: number
          p_tenant_id: string
          p_tier_id: string
        }
        Returns: Json
      }
      redeem_customer_credits: {
        Args: { p_amount: number; p_customer_id: string; p_note?: string }
        Returns: number
      }
      referral_code_slug: { Args: { p_name: string }; Returns: string }
      refund_payment: {
        Args: { p_payment_id: string; p_reason: string }
        Returns: Json
      }
      reject_expense_claim: {
        Args: { p_claim_id: string; p_reason?: string }
        Returns: undefined
      }
      reopen_quote: { Args: { p_quote_id: string }; Returns: undefined }
      report_balance_sheet: {
        Args: { p_as_of?: string }
        Returns: {
          advances_from_customers: number
          as_of: string
          bills_gst: number
          business_loans_payable: number
          cash_and_bank: number
          credit_card_payable: number
          dues_esi: number
          dues_paid: Json
          dues_pf: number
          dues_salary_tds: number
          dues_vendor_tds: number
          emi_loans_payable: number
          emi_unregistered_cost: number
          employee_loans: number
          fixed_assets: Json
          fy_label: string
          fy_start_year: number
          gst_output: number
          itc_groups: Json
          payables: number
          prepaid_advances: number
          project_receivable: number
          receivables: number
          reimbursements_payable: number
          salary_payable: number
          tax_payments: Json
          tds_receivable: number
        }[]
      }
      report_day_book: { Args: { p_from: string; p_to: string }; Returns: Json }
      report_ledger_vendors: { Args: never; Returns: Json }
      report_party_ledger: {
        Args: { p_from: string; p_kind: string; p_party: string; p_to: string }
        Returns: Json
      }
      report_pnl: {
        Args: { p_from: string; p_to: string }
        Returns: {
          bills_gst: number
          cn_tax: number
          cn_taxable: number
          cogs: number
          cogs_count: number
          commissions: number
          commissions_count: number
          dn_tax: number
          dn_taxable: number
          expense_groups: Json
          inv_tax: number
          inv_taxable: number
          itc_groups: Json
          project_expenses: Json
          revenue_by_project: Json
          revenue_count: number
          unassigned_by_category: Json
        }[]
      }
      report_pnl_monthly: {
        Args: { p_from: string; p_to: string }
        Returns: Json
      }
      reset_tenant_selected_tables: {
        Args: {
          p_confirm_statutory?: boolean
          p_label: string
          p_tables: string[]
        }
        Returns: Json
      }
      resolve_or_create_contact: {
        Args: {
          p_company: string
          p_email: string
          p_name: string
          p_phone: string
          p_tenant: string
        }
        Returns: string
      }
      restore_tenant_backup: { Args: { p_id: string }; Returns: Json }
      salary_expense_date: {
        Args: { p_pay_date: string; p_period: string }
        Returns: string
      }
      save_package: {
        Args: {
          p_discount_pct: number
          p_id: string
          p_is_active: boolean
          p_items: Json
          p_name: string
          p_pitch: string
        }
        Returns: string
      }
      set_document_series_start: {
        Args: {
          p_doc_type: string
          p_fiscal_year: string
          p_prefix?: string
          p_start_number: number
        }
        Returns: undefined
      }
      set_employee_pin: {
        Args: { p_employee_id: string; p_pin: string }
        Returns: undefined
      }
      set_my_employee: { Args: { p_employee_id: string }; Returns: undefined }
      set_subscription_auto_renew: {
        Args: { p_sub_id: string; p_value: boolean }
        Returns: boolean
      }
      settle_employee_advance: {
        Args: { p_account?: string; p_advance_id: string; p_date?: string }
        Returns: number
      }
      settle_expense_advance: {
        Args: {
          p_category: string
          p_date: string
          p_loan_id: string
          p_notes?: string
          p_return_account: string
          p_return_amount: number
          p_spent_amount: number
        }
        Returns: undefined
      }
      settle_reimbursement: {
        Args: { p_id: string; p_notes: string; p_settled_on: string }
        Returns: undefined
      }
      split_project_milestone: {
        Args: { p_amount: number; p_label: string; p_milestone_id: string }
        Returns: string
      }
      submit_expense_claim: {
        Args: {
          p_amount: number
          p_category: string
          p_employee_id: string
          p_pin: string
          p_purpose: string
          p_receipt_path?: string
          p_spent_on: string
          p_tenant_id: string
        }
        Returns: string
      }
      suggest_bank_transaction_matches: {
        Args: { p_bank_txn_id: string }
        Returns: {
          match_amount: number
          match_confidence: string
          match_date: string
          match_id: string
          match_label: string
          match_type: string
        }[]
      }
      sync_domain_catalog: { Args: { p_tlds: Json }; Returns: number }
      sync_hosting_catalog: { Args: { p_plans: Json }; Returns: number }
      sync_partner_item:
        | {
            Args: { p_my_msrp?: number; p_partner_item_id: string }
            Returns: string
          }
        | {
            Args: {
              p_link_existing_id?: string
              p_my_msrp?: number
              p_partner_item_id: string
            }
            Returns: string
          }
      tds_mark_26as_verified: {
        Args: { p_ids: string[]; p_seen_on: string }
        Returns: number
      }
      today_inbox: {
        Args: never
        Returns: {
          due_at: string
          href: string
          id: string
          kind: string
          priority: number
          title: string
        }[]
      }
      top_up_employee_advance: {
        Args: {
          p_account?: string
          p_advance_id: string
          p_amount: number
          p_date?: string
        }
        Returns: number
      }
      undo_my_last_punch: { Args: never; Returns: string }
      unreconcile_bank_receipt: {
        Args: { p_txn_id: string; p_undo_sale?: boolean }
        Returns: Json
      }
      update_employee_advance: {
        Args: {
          p_advance_id: string
          p_amount: number
          p_date: string
          p_name: string
          p_note?: string
        }
        Returns: undefined
      }
      update_project_details: {
        Args: {
          p_customer_id?: string
          p_customer_name?: string
          p_description?: string
          p_gst_rate?: number
          p_inter_state?: boolean
          p_milestones?: Json
          p_project_id: string
          p_title?: string
          p_total_amount?: number
        }
        Returns: undefined
      }
      update_project_future_milestones: {
        Args: { p_milestones: Json; p_project_id: string }
        Returns: undefined
      }
      update_project_quote: {
        Args: {
          p_customer_name: string
          p_description: string
          p_gst_rate: number
          p_inter_state: boolean
          p_line_items: Json
          p_milestones: Json
          p_project_id: string
          p_title: string
        }
        Returns: undefined
      }
      verify_claim_access: {
        Args: { p_employee_id: string; p_pin: string; p_tenant_id: string }
        Returns: number
      }
      visible_owner_ids: { Args: never; Returns: string[] }
      whatsapp_reminder_status_rank: { Args: { p: string }; Returns: number }
    }
    Enums: {
      billing_cycle: "monthly" | "quarterly" | "half_yearly" | "yearly"
      invoice_status: "draft" | "pending" | "paid" | "overdue" | "void"
      lead_pipeline: "new_logo" | "migration" | "renewal"
      lead_stage:
        | "new"
        | "contact"
        | "demo"
        | "trial"
        | "quote"
        | "won"
        | "lost"
      mandate_status:
        | "pending_authorisation"
        | "active"
        | "paused"
        | "cancelled"
        | "expired"
      payment_status: "none" | "awaiting" | "partial" | "received" | "invoiced"
      quote_approval_status:
        | "not_required"
        | "pending"
        | "approved"
        | "rejected"
      quote_approval_tier: "manager" | "owner"
      quote_status:
        | "draft"
        | "sent"
        | "viewed"
        | "accepted"
        | "rejected"
        | "expired"
      renewal_state:
        | "pending"
        | "notice_sent"
        | "reminder_1"
        | "reminder_2"
        | "reminder_3"
        | "reminder_4"
        | "final_sent"
        | "grace_period"
        | "renewed"
        | "suspended"
        | "early_notice"
      seat_request_status: "pending" | "approved" | "rejected" | "withdrawn"
      sub_status: "active" | "paused" | "expired" | "cancelled"
      task_kind: "call" | "email" | "meeting" | "followup" | "custom"
      task_status: "pending" | "done" | "snoozed" | "cancelled"
      user_role:
        | "owner"
        | "sales"
        | "accountant"
        | "support"
        | "sales_senior"
        | "manager"
        | "billing"
        | "delivery"
        | "partner_agent"
      vault_category:
        | "google_admin"
        | "m365_admin"
        | "dns_registrar"
        | "cpanel"
        | "distributor"
        | "other"
      vendor:
        | "google"
        | "microsoft"
        | "zoho"
        | "other"
        | "domain"
        | "hosting"
        | "support"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      billing_cycle: ["monthly", "quarterly", "half_yearly", "yearly"],
      invoice_status: ["draft", "pending", "paid", "overdue", "void"],
      lead_pipeline: ["new_logo", "migration", "renewal"],
      lead_stage: ["new", "contact", "demo", "trial", "quote", "won", "lost"],
      mandate_status: [
        "pending_authorisation",
        "active",
        "paused",
        "cancelled",
        "expired",
      ],
      payment_status: ["none", "awaiting", "partial", "received", "invoiced"],
      quote_approval_status: [
        "not_required",
        "pending",
        "approved",
        "rejected",
      ],
      quote_approval_tier: ["manager", "owner"],
      quote_status: [
        "draft",
        "sent",
        "viewed",
        "accepted",
        "rejected",
        "expired",
      ],
      renewal_state: [
        "pending",
        "notice_sent",
        "reminder_1",
        "reminder_2",
        "reminder_3",
        "reminder_4",
        "final_sent",
        "grace_period",
        "renewed",
        "suspended",
        "early_notice",
      ],
      seat_request_status: ["pending", "approved", "rejected", "withdrawn"],
      sub_status: ["active", "paused", "expired", "cancelled"],
      task_kind: ["call", "email", "meeting", "followup", "custom"],
      task_status: ["pending", "done", "snoozed", "cancelled"],
      user_role: [
        "owner",
        "sales",
        "accountant",
        "support",
        "sales_senior",
        "manager",
        "billing",
        "delivery",
        "partner_agent",
      ],
      vault_category: [
        "google_admin",
        "m365_admin",
        "dns_registrar",
        "cpanel",
        "distributor",
        "other",
      ],
      vendor: [
        "google",
        "microsoft",
        "zoho",
        "other",
        "domain",
        "hosting",
        "support",
      ],
    },
  },
} as const

