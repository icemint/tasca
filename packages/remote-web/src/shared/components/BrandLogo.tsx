interface BrandLogoProps {
  className?: string;
  alt?: string;
}

export function BrandLogo({
  className = "h-8 w-auto",
  alt = "Tasca",
}: BrandLogoProps) {
  return (
    <picture>
      <source
        srcSet="/tasca-logo-dark.svg"
        media="(prefers-color-scheme: dark)"
      />
      <img src="/tasca-logo.svg" alt={alt} className={className} />
    </picture>
  );
}
