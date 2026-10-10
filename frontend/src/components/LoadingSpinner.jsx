import React from 'react';

const LoadingSpinner = ({ size = 'medium', text = 'Đang tải...', className = '' }) => {
  const sizeClasses = {
    small: 'w-4 h-4',
    medium: 'w-8 h-8',
    large: 'w-12 h-12'
  };

  return (
    <div className={`flex flex-col items-center justify-center ${className}`}>
      <div className={`loading-spinner ${sizeClasses[size]} mb-2`}></div>
      {text && (
        <p className="text-gray-600 text-sm vietnamese-text">{text}</p>
      )}
    </div>
  );
};

export default LoadingSpinner;
