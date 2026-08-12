import { redirect } from "next/navigation";

// /jobs/[id] has no content of its own — the worksheet is a job's home tab.
export default async function JobIndexPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/jobs/${id}/worksheet`);
}
