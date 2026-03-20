import TenderDetailClient from "./ui";

export default async function TenderDetailPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <TenderDetailClient id={id} />;
}
