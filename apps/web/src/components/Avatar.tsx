import { useEffect, useState } from "react";

/**
 * Avatar kontak bersama (Fase 6D): foto profil asli bila `imageUrl`
 * tersedia (endpoint avatar kita sendiri — kontak Telegram), selain itu
 * inisial berwarna. Jatuh kembali ke inisial juga bila gambar GAGAL
 * dimuat (mis. foto terhapus di antara muat daftar & render), agar tidak
 * pernah ada ikon gambar rusak di daftar. Kontak webchat memang tidak
 * punya foto (pengunjung anonim) — untuk mereka inisial adalah tampilan
 * final yang disengaja, bukan keadaan kosong.
 */
interface AvatarProps {
  /** Nama pemilik — sumber inisial fallback. */
  name: string;
  imageUrl?: string | null;
  /** Kelas ukuran + teks (default 40px). */
  className?: string;
}

export function Avatar({
  name,
  imageUrl,
  className = "h-10 w-10 text-sm",
}: AvatarProps) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [imageUrl]);

  if (imageUrl && !failed) {
    return (
      <img
        src={imageUrl}
        alt=""
        onError={() => setFailed(true)}
        className={`${className} shrink-0 rounded-full border border-line object-cover`}
      />
    );
  }
  const initial = (name.trim().charAt(0) || "?").toUpperCase();
  return (
    <span
      className={`flex ${className} shrink-0 items-center justify-center rounded-full bg-accent/10 font-bold text-accent`}
      aria-hidden={true}
    >
      {initial}
    </span>
  );
}
