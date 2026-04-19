import { loadGoodsExtractionCheckForTender } from "@/lib/tender/load-goods-extraction-check-ui";
import TenderDetailClient from "./ui";

export default async function TenderDetailPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const goodsExtractionCheck = await loadGoodsExtractionCheckForTender(id);
  return <TenderDetailClient id={id} goodsExtractionCheck={goodsExtractionCheck} />;
}
