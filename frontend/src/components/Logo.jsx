import React from 'react';

const Logo = ({ size = 'md', className = '' }) => {
  const sizeClasses = {
    sm: 'h-6',
    md: 'h-8',
    lg: 'h-12',
    xl: 'h-16'
  };

  return (
    <img 
      src="/logo.png"
      alt="SAB Logo"
      className={`${sizeClasses[size]} ${className} object-contain`}
    />
  );
};

export default Logo;
