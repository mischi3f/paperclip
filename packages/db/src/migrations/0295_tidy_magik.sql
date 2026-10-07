ALTER TABLE "issues" DROP CONSTRAINT "issues_parent_id_issues_id_fk";
--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_company_parent_fk" FOREIGN KEY ("company_id","parent_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;